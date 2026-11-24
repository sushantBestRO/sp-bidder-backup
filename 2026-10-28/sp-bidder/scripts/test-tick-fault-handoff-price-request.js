'use strict';
/**
 * TICK-FAULT HAND-OFF PRICE REQUEST - when the engine hands a load to the desk after its ticks keep
 * faulting, the load's price request stops claiming the engine will bid it.
 *
 * Regression target: review finding on the tick-fault hand-off (branch fix/timer-lifecycle-orphans,
 * head fca118e).
 *   siblings: scripts/test-tick-fault-handoff-unsaved-alert.js, scripts/test-tick-fault-after-finalize.js
 *
 * _handTickFaultToDesk stops the monitor and saves the intent as 'stopped', then emits
 * tick_fault_handoff. Nothing consumed that event on the price-request side, so the request stayed
 * 'armed': /track told the shipper "Waiting for the auction to open" on a live load nothing was
 * bidding, and /price kept the re-price form, whose submit re-arms the engine on a load the desk is
 * now bidding by hand.
 *
 * Chain under test: the REAL mock-mode server stack -> its engine's emit -> makeEngine's onEvent ->
 * the shared PriceRequestStore -> the /price and /track routes over real HTTP on localhost.
 *
 * WHAT MUST NOT MOVE:
 *   - an armed request leaves 'armed' as a hold with the hand-off reason (check 1);
 *   - its /price page says we stopped and asked the desk to bid by hand, with no cost form (check 2);
 *   - its /track status data is not the armed "waiting to open" state (check 3);
 *   - a request still awaiting a cost is left alone by the same event (check 4, control).
 *
 * Offline: PLATFORM=mock, memory store, ephemeral localhost port, no sleeps beyond settling promises.
 *
 *   node scripts/test-tick-fault-handoff-price-request.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const http = require('http');

class SetupError extends Error {}
const setup = (cond, msg) => { if (!cond) throw new SetupError('SETUP: ' + msg); };

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

let pass = 0;
const failures = [];
const check = (n, cond, msg) => {
  if (cond) { pass++; console.log(`  ok ${n} - ${msg}`); } else { failures.push(`${n} - ${msg}`); console.error(`  FAIL ${n} - ${msg}`); }
};

let server = null;

(async () => {
  const { app, requests, stacks } = require('../src/web/server');
  const { publicSeg } = require('../src/pricing/priceRequests');

  setup(stacks.length >= 1 && stacks[0].engine, 'mock mode built a stack with an engine');
  const engine = stacks[0].engine;

  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => new Promise((resolve, reject) => {
    http.get(base + p, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });

  const load = (id) => ({
    id, lane: { origin: 'Pune', destination: 'Alwar' },
    companyName: 'Havells India Limited', equipment: '32 Feet', units: 1,
    weight: 16, weightUnit: 'MT', closesAt: Date.now() + 40 * 60_000,
    softClose: false, closeModelKnown: true,
  });

  // Arrange
  const armed = await requests.createForLoad(load('TFH-1'), { deadlineAt: Date.now() + 30 * 60_000 });
  await requests.capture(armed.id, { cost: 50_000 });
  const waiting = await requests.createForLoad(load('TFH-2'), { deadlineAt: Date.now() + 30 * 60_000 });
  setup((await requests.getByToken(armed.id)).status === 'armed', 'first request is armed before the hand-off');
  setup((await requests.getByToken(waiting.id)).status === 'awaiting_price', 'second request awaits a cost before the hand-off');

  // Act
  const handOff = (auctionId) => engine.emit({ type: 'alert', level: 'error', kind: 'tick_fault_handoff', auctionId,
    faultSince: Date.now() - 5_000, consecutiveFaults: 3, landedBids: 0, standingBidPrice: null, myRank: null,
    closesAt: Date.now() + 40 * 60_000,
    detail: `Load ${auctionId}: 3 checks in a row failed on our side, so we stopped bidding this load and asked the desk to bid it by hand.`,
    lane: 'Pune -> Alwar', companyName: 'Havells India Limited' });
  handOff('TFH-1');
  handOff('TFH-2');
  await settle();

  // Assert
  const after = await requests.getByToken(armed.id);
  check(1, after.status === 'stopped' && after.heldReason === 'tick_fault_handoff',
    `armed request is held as stopped/tick_fault_handoff after the hand-off (got ${after.status}/${after.heldReason || 'none'})`);

  const price = await get(`/price/${publicSeg(armed)}`);
  const priceBody = price.body.replace(/<[^>]+>/g, ' ');
  check(2, price.status === 200 && /stopped bidding/i.test(priceBody) && /desk/i.test(priceBody) && /by hand/i.test(priceBody)
    && !/id="mainForm"/.test(price.body),
    `/price says we stopped and the desk bids by hand, with no re-price form (status ${price.status}, form shown: ${/id="mainForm"/.test(price.body)})`);

  const track = await get(`/track/${publicSeg(armed)}/state`);
  const state = JSON.parse(track.body);
  const trackPage = await get(`/track/${publicSeg(armed)}`);
  check(3, track.status === 200 && state.requestStatus !== 'armed' && state.heldReason === 'tick_fault_handoff'
    && /tick_fault_handoff'\s*\?\s*'[^']*desk[^']*'/.test(trackPage.body),
    `/track status is not "Waiting for the auction to open" and names the desk hand-off (requestStatus ${state.requestStatus}, heldReason ${state.heldReason})`);

  const control = await requests.getByToken(waiting.id);
  check(4, control.status === 'awaiting_price' && !control.heldReason,
    `a request awaiting a cost is untouched by the hand-off (got ${control.status}/${control.heldReason || 'none'})`);

  server.close();
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} check(s) - a tick-fault hand-off left the load's price request armed, `
      + 'so /price and /track still promise the engine will bid a load the desk now bids by hand');
    process.exit(1);
  }
  console.log(`\nPASS: ${pass}/4 checks`);
  console.log('EXPECTED: tick-fault hand-off moves an armed price request to a desk hold - complete');
  process.exit(0);
})().catch((e) => {
  try { if (server) server.close(); } catch (_) {}
  console.error(e instanceof SetupError ? e.message : e);
  process.exit(1);
});
