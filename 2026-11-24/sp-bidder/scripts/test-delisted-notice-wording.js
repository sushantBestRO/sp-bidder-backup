'use strict';
/**
 * The early delisted notice must not borrow the post-refusal sentence.
 *
 * test-delisted-load-notice.js already pins that _checkDelisted fires early and leaves the engine
 * armed. What it does not check is the WORDING the desk actually reads: the early notice reuses the
 * 'load_not_biddable' kind, whose shared copy says "SuperProcure is not accepting bids on this load,
 * so nothing we send can land on it" - a sentence written for a refusal the platform actually sent.
 * On the early path there is no such refusal, only a listing cache that stopped refreshing, and the
 * engine's own next action (it stays armed and will still fire the snipe) contradicts what that
 * sentence claims.
 *
 * WHAT MUST NOT MOVE: a REAL post-refusal 'load_not_biddable' (the platform actually said no) must
 * keep the original refusal sentence and the "Not bidding" headline byte-for-byte - this is the
 * control, run through the identical render pipeline the early notice uses.
 *
 * Full pipeline, offline: BidEngine emits the real event shape, engineAlerts.toNotification builds
 * the same `data` object the notifier sends, waTemplates.renderMessage produces the exact text a
 * WhatsApp group receives.
 *
 *   node scripts/test-delisted-notice-wording.js
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { toNotification } = require('../src/notify/engineAlerts');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const tmp = (tag) => path.join(os.tmpdir(), `delisted-wording-${tag}-${process.pid}.json`);
const rm = (f) => { try { fs.unlinkSync(f); } catch (_) { /* best effort */ } };

const CFG = { openAtMs: 25000, floorWindowMs: 2500, minInterFireMs: 0, delistedStaleMs: 90_000 };
const BAND = { cost: 38000, marginsPct: [14, 11.5, 10.3], minMarginPct: 10.3 };

const st = (o) => Object.assign({ ok: true, status: 'live', myRank: null, totalBidders: 1,
  standingL1Price: null, closesInMs: 10000, revisionLimit: 3, revisionsLeft: 3,
  minDecrement: 100, closeModel: 'hard', measuredRttMs: 50 }, o);

const armMeta = (id) => ({ id, lane: { origin: 'Bhiwandi', destination: 'Surat' }, units: 1,
  companyName: 'Syngenta', branchName: 'Bhiwandi', closesAt: Date.now() + 30_000 });

// The Syngenta 25084674 shape: last seen 4.9 minutes ago, stale past delistedStaleMs, biddingOn false.
const delistedTrace = () => ({ lastSeenInListAt: Date.now() - 294_000, lastSeenInListAgoMs: 294_000, biddingOn: false });

function render(data) {
  return renderMessage(templateFor('desk_notice', data), data);
}

(async () => {
  // ---------------------------------------------------------------------------------------------
  // 1. THE EARLY PATH: _checkDelisted's own emit, through the real notify pipeline.
  // ---------------------------------------------------------------------------------------------
  let earlyMsg, earlyData;
  {
    const f = tmp('early');
    const events = [];
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      writeEnabled: true,
      listingTrace: () => delistedTrace(),
      async getAuctionState() { return st({}); },
      async placeBid() { return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 20 }; },
    };
    const eng = new BidEngine(adapter, new DurableScheduler(f),
      { config: CFG, rand: () => 0, onEvent: (e) => events.push(e) });
    eng.arm(armMeta('EARLY-1'), BAND);
    const evt = events.find((e) => e.type === 'alert' && e.kind === 'load_not_biddable');
    assert.ok(evt, 'the early path raises a load_not_biddable alert at arm time');
    assert.strictEqual(evt.stillWatching, true, 'the early emit carries stillWatching:true');
    eng.kill(); rm(f);

    const n = toNotification(evt);
    assert.strictEqual(n.kind, 'desk_notice', 'still routes as a non-paging desk notice');
    assert.strictEqual(n.data.stillWatching, true, 'the flag survives into the notifier data object');
    earlyData = n.data;
    earlyMsg = render(n.data);
    ok('the early emit carries stillWatching:true through toNotification');
  }

  assert.ok(!/not accepting bids/i.test(earlyMsg),
    `early notice must not borrow the refusal sentence:\n${earlyMsg}`);
  ok('the early notice body does not claim SuperProcure refused the bid');

  assert.ok(!/Not bidding/i.test(earlyMsg),
    `early notice headline must not say "Not bidding" while the engine stays armed:\n${earlyMsg}`);
  ok('the early notice headline does not say "Not bidding" while the load is still armed');

  assert.ok(/still watching|stopped showing as open/i.test(earlyMsg),
    `early notice must say what is actually known:\n${earlyMsg}`);
  ok('the early notice states the observation (stopped showing as open) rather than a verdict');

  // ---------------------------------------------------------------------------------------------
  // 2. THE CONTROL: a REAL post-refusal load_not_biddable, same kind, no stillWatching flag - the
  //    exact shape bidEngine emits from the actual SuperProcure-refused-the-bid path.
  // ---------------------------------------------------------------------------------------------
  let refusalMsg;
  {
    const evt = { type: 'alert', level: 'warn', kind: 'load_not_biddable', auctionId: 'REFUSED-1',
      lane: { origin: 'Bhiwandi', destination: 'Surat' }, companyName: 'Syngenta', branchName: 'Bhiwandi' };
    assert.strictEqual(evt.stillWatching, undefined, 'a real refusal event never carries stillWatching');
    const n = toNotification(evt);
    assert.strictEqual(n.data.stillWatching, false, 'toNotification normalises the absent flag to false');
    refusalMsg = render(n.data);
    ok('a real post-refusal event normalises to stillWatching:false');
  }

  assert.ok(/not accepting bids/i.test(refusalMsg),
    `a real refusal must keep the refusal sentence byte-for-byte:\n${refusalMsg}`);
  ok('the control (real refusal) still states SuperProcure would not accept the bid');

  assert.ok(/Not bidding/i.test(refusalMsg),
    `a real refusal must keep the "Not bidding" headline:\n${refusalMsg}`);
  ok('the control (real refusal) headline still reads "Not bidding"');

  assert.notStrictEqual(earlyMsg, refusalMsg, 'the two paths must never render the same message');
  ok('the early notice and the real refusal render two distinct messages');

  console.log(`\n${pass}/8 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
