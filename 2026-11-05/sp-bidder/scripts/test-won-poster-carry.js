'use strict';
/**
 * Regression: the LOAD POSTER (the shipper-side contact who put the load on SuperProcure) must reach
 * the WON WhatsApp receipt, so BRL's own manager has the name and number to ring and get the vehicle
 * placed. Suyashh's ask, 2026-07-28: "in the won message also, the manager who posted, the manager of
 * the company, his name and number should come so that our manager can coordinate with them and place
 * the vehicle".
 *
 * The poster is snapshotted on the PriceRequest at intake (pinned by test-load-poster-display.js), and
 * the won TEMPLATE renders it (also pinned there). What this file pins is the stretch in between - the
 * carry path through the engine, which is the half that silently drops a load fact:
 *   A. capture -> armFromRequest -> auction_result -> won alert payload -> rendered won message
 *   B. scheduled load: schedule() persists poster on the intent; the wake arms with it
 *   C. restart: rehydrate() re-arms from the intent with poster intact (fresh store = worst case)
 *   D. a poster-less load carries an explicit null the whole way and renders no contact line
 *
 * B and C are not hypothetical. companyName was dropped on exactly these two paths once already
 * (load 22918820: shipper null in closedBids, "" in the lost alert - see
 * test-arm-shipper-regression.js), and `sh scripts/deploy.sh` restarts pm2 mid-auction as a matter of
 * routine, so any load fact that does not ride the durable intent is one deploy away from vanishing
 * from the message that needs it.
 *
 * EVERY NAME AND NUMBER BELOW IS FABRICATED - the DEMO POSTER NAME / 9000012345 pair follows the
 * repo-wide fake-contact convention. No real shipper contact appears in this file.
 *
 *   node scripts/test-won-poster-carry.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { PriceRequestStore, armFromRequest } = require('../src/pricing/priceRequests');
const { toNotification } = require('../src/notify/engineAlerts');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (tag) => path.join(os.tmpdir(), `won-poster-${tag}-${process.pid}.json`);
const BAND = [12.6, 7.2, 6.3];
const CFG = { armLeadMs: 300 };
const POSTER = { name: 'DEMO POSTER NAME', mobile: '9000012345', createdBy: '90001' };

/** rank-only adapter with a flippable state: open (rank 2, hot window) -> closed at a chosen rank. */
function flippableAdapter() {
  const a = {
    st: { ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
      closesInMs: 8_000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 },
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ...a.st }),
    placeBid: async () => ({ accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 40 }),
    close: (rank) => { a.st = { ...a.st, status: 'closed', myRank: rank, closesInMs: 0 }; },
  };
  return a;
}

function mkLoad(id, { startsAt, status, poster = POSTER }) {
  return {
    id, lane: { origin: 'Pune', destination: 'Akola' }, equipment: '22 Feet', units: 1,
    companyName: 'ADAMA India Private Limited', branchName: 'Pune',
    closesAt: Date.now() + 8_000, startsAt, status, softClose: false, poster,
  };
}

function rig(adapter, intentsFile) {
  const store = createStore({ backend: 'memory' });
  const events = [];
  const engine = new BidEngine(adapter, new DurableScheduler(intentsFile), {
    config: CFG,
    onEvent: (e) => { events.push(e); },
  });
  return { store, events, engine };
}

/** capture a cost on a fresh request for `load` and hand it to the engine. */
async function armed(engine, store, load) {
  const rq = new PriceRequestStore({ store, marginsPct: BAND, minMarginPct: 6.3 });
  // These fixtures close in SECONDS, so createForLoad's derived deadlineAt (closesAt - lead) would
  // land in the past and capture() would rightly refuse. deadlineAt gates capture() alone and never
  // engine timing, so holding it open explicitly leaves every assertion below unchanged.
  const created = await rq.createForLoad(load, { deadlineAt: Date.now() + 60_000 });
  return armFromRequest(engine, await rq.capture(created.id, { cost: 26_000 }));
}

(async () => {
  // ---- A. live path: armFromRequest -> auction_result -> won payload -> rendered won message ----
  {
    const f = tmp('live');
    const adapter = flippableAdapter();
    const { store, events, engine } = rig(adapter, f);
    await armed(engine, store, mkLoad('WP1', { startsAt: Date.now() - 1000, status: 'live' }));

    assert.deepStrictEqual(engine.scheduler.get('WP1').poster, POSTER, 'the armed intent persists the poster');
    ok('armFromRequest -> arm() persists the poster on the durable intent');

    await sleep(600);                // engine is live -> places the establishing bid
    adapter.close(1);                // auction ends at rank 1: WE WON
    await sleep(800);
    const result = events.find((e) => e.type === 'auction_result');
    assert.ok(result && result.won === true, 'auction_result emitted as a WIN');
    assert.deepStrictEqual(result.poster, POSTER, 'the auction_result event carries the poster');

    const n = toNotification(result);
    assert.strictEqual(n.kind, 'won', 'the win routes as the won kind');
    assert.deepStrictEqual(n.data.poster, POSTER, 'the won alert payload carries the poster');
    ok('the poster survives arm -> auction_result -> won alert payload');

    // the message the desk actually receives - the whole point of the carry path
    const msg = renderMessage(templateFor('won', n.data), n.data);
    assert.ok(/📞 \*Posted by\* - DEMO POSTER NAME · \+919000012345/.test(msg),
      'the rendered won message names the contact with a tappable +91 number');
    assert.ok(msg.indexOf('Posted by') < msg.indexOf('Complete the allotment'),
      'and it sits above the allotment CTA it exists to serve');
    ok('the end-to-end won message carries the contact the manager rings to place the vehicle');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // ---- B. scheduled load: the intent persists the poster; the WAKE arms with it ----
  {
    const f = tmp('sched');
    const adapter = flippableAdapter();
    const { store, events, engine } = rig(adapter, f);
    await armed(engine, store, mkLoad('WP2', { startsAt: Date.now() + 700, status: 'scheduled' }));

    assert.strictEqual(engine.scheduler.get('WP2').status, 'scheduled', 'not-yet-started load -> scheduled intent');
    assert.deepStrictEqual(engine.scheduler.get('WP2').poster, POSTER, 'schedule() persists the poster on the intent');
    ok('schedule() persists the poster (a pre-armed load is armed by the wake, not by the capture)');

    await sleep(900);                // wake fires at startsAt - armLeadMs
    assert.ok(events.some((e) => e.type === 'armed'), 'the wake armed the load');
    adapter.close(1);
    await sleep(800);
    const result = events.find((e) => e.type === 'auction_result');
    assert.deepStrictEqual(result && result.poster, POSTER, 'the wake-armed load still names the poster at close');
    ok('schedule -> wake -> arm -> win keeps the poster through the intent round-trip');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // ---- C. restart: rehydrate re-arms with the poster, over a FRESH store ----
  {
    const f = tmp('restart');
    const adapter = flippableAdapter();
    // session 1: arm via the price-request path, then "crash" mid-auction (what deploy.sh does)
    {
      const { store, engine } = rig(adapter, f);
      await armed(engine, store, mkLoad('WP3', { startsAt: Date.now() - 1000, status: 'live' }));
      assert.deepStrictEqual(engine.scheduler.get('WP3').poster, POSTER, 'the armed intent persists the poster');
      engine.kill('simulated crash');
    }
    // session 2: fresh engine + EMPTY store rehydrates from disk alone
    const { events: events2, engine: engine2 } = rig(adapter, f);
    await engine2.rehydrate();
    assert.ok(events2.some((e) => e.type === 'armed'), 'rehydrate re-armed the load');
    adapter.close(1);
    await sleep(800);
    const result = events2.find((e) => e.type === 'auction_result');
    assert.deepStrictEqual(result && result.poster, POSTER, 'the rehydrated load still names the poster at close');
    const msg = renderMessage('won', toNotification(result).data);
    assert.ok(/DEMO POSTER NAME · \+919000012345/.test(msg), 'and the post-restart win message still carries the contact');
    ok('restart/rehydrate keeps the poster (a mid-auction deploy no longer strips the contact)');
    engine2.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // ---- D. a poster-less load carries an explicit null and renders no line ----
  {
    const f = tmp('none');
    const adapter = flippableAdapter();
    const { store, events, engine } = rig(adapter, f);
    await armed(engine, store, mkLoad('WP4', { startsAt: Date.now() - 1000, status: 'live', poster: null }));

    assert.strictEqual(engine.scheduler.get('WP4').poster, null, 'the intent stores an explicit null, never undefined-by-accident');
    await sleep(600);
    adapter.close(1);
    await sleep(800);
    const result = events.find((e) => e.type === 'auction_result');
    assert.strictEqual(result && result.poster, null, 'the auction_result carries null');
    const n = toNotification(result);
    assert.strictEqual(n.data.poster, null, 'the won payload carries null');
    const msg = renderMessage('won', n.data);
    assert.ok(!/Posted by/.test(msg), 'a poster-less win renders no contact line (never a stranded label)');
    assert.ok(/Complete the allotment on SuperProcure/.test(msg), 'and the rest of the win receipt is unchanged');
    ok('a poster-less load stays null end-to-end and the win message is byte-unchanged');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // Completion sentinel. run-tests.js grades a file by its EXIT STATUS alone, so an early return
  // (or a section quietly dropped in a later edit) would exit 0 and be scored green while having
  // asserted less than it claims. Assert the expected check count so that failure is loud.
  assert.strictEqual(pass, 7, `expected all 7 checks to run, got ${pass}`);
  console.log(`\n${pass}/7 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
