'use strict';
/**
 * Simulated SuperProcure clock for the scripts/test-sp-clock-*.js files.
 *
 * One fake local clock (Date.now), a SuperProcure server clock `theta` ms ahead of it, a REST
 * transport whose request and response legs take chosen times, and `current` heartbeats delivered
 * after a chosen one-way delay. Everything runs through the real RealSuperProcureAdapter and the
 * real SpSocket (never connected: the heartbeat handler and the bid-frame handler are driven as
 * methods, the way test-sp-time-field-bounds.js and test-socket-flow.js drive them).
 *
 * The truth every test scores against is the server clock this file owns: at local time L the
 * portal reads L + theta, so a load closing at server time C has C - (L + theta) left.
 *
 * Not a test file - the runner only executes scripts/test-*.js.
 */
const { SpSocket } = require('../../src/platform/spSocket');
const { RealSuperProcureAdapter } = require('../../src/platform/realAdapter');

const START = 1_789_990_000_000;

function createSim({ theta = 0, start = START } = {}) {
  let clock = start;
  Date.now = () => clock;
  const legs = { up: 0, down: 0 };

  const sim = {
    theta,
    now: () => clock,
    at(t) {
      if (t < clock) throw new Error(`sim clock cannot run backwards (${t} < ${clock})`);
      clock = t;
      return clock;
    },
    advance(ms) { clock += ms; return clock; },
    serverNow: () => clock + sim.theta,
    trueRemaining: (closeServerMs) => closeServerMs - (clock + sim.theta),
  };

  // Every REST call answers with SuperProcure's real getAvailableViews shape: `currentTime` in whole
  // Unix SECONDS (captured 2026-08-04..09-08, five HARs), stamped when the request reaches the server.
  const fetchImpl = async () => {
    clock += legs.up;
    const stamp = clock + sim.theta;
    clock += legs.down;
    const body = { data: {
      currentTime: Math.floor(stamp / 1000), isCarrier: true,
      userInfo: { name: 'Test User', companyName: 'Best Roadways' },
      carrierBranches: [2667], branchList: { 956055: { branchId: 956055 } },
    } };
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };

  sim.adapter = new RealSuperProcureAdapter({ token: 'x', fetchImpl, sleep: async () => {} });
  sim.sock = new SpSocket({ token: 'x', carrierId: 2667, userId: 'u' });
  sim.adapter.attachSocket(sim.sock);

  // One REST round trip with the given legs. The adapter measures it however it measures its own
  // requests; the test only controls how long each leg really took.
  sim.rest = async (upMs, downMs) => {
    legs.up = upMs; legs.down = downMs;
    await sim.adapter._get('/sp/base/getAvailableViews?isWeb=1');
  };
  sim.login = async (upMs, downMs) => {
    legs.up = upMs; legs.down = downMs;
    return sim.adapter.login();
  };

  // A `current` heartbeat stamped at server time `stampServerMs`, arriving `oneWayMs` later.
  sim.heartbeat = (stampServerMs, oneWayMs, raw = stampServerMs) => {
    sim.at(stampServerMs - sim.theta + oneWayMs);
    sim.sock._onClock({ time: raw });
  };

  sim.hbEvent = (stampServerMs, oneWayMs, raw = stampServerMs) => ({
    at: stampServerMs - sim.theta + oneWayMs,
    run: async () => { sim.sock._onClock({ time: raw }); },
  });
  sim.restEvent = (atLocalMs, upMs, downMs) => ({ at: atLocalMs, run: () => sim.rest(upMs, downMs) });

  sim.setClose = (loadId, closeServerMs) => {
    sim.sock._onBid({ loadId: Number(loadId), bids: [],
      fieldsToBeUpdated: { loadEndTime: new Date(closeServerMs).toISOString() } });
  };

  // The engine's read of the load right now, and how far its countdown is from the truth.
  // Positive err = the countdown says MORE time is left than really is (optimistic, the late side).
  sim.read = async (loadId, closeServerMs) => {
    const st = await sim.adapter.getAuctionState(String(loadId));
    return { st, err: st.closesInMs - sim.trueRemaining(closeServerMs) };
  };

  return sim;
}

// Events are delivered in LOCAL arrival order, which is not server-stamp order once delays differ.
// Each event is { at: localMs, run: async () => {} }.
async function runTimeline(sim, events) {
  const ordered = events.slice().sort((a, b) => a.at - b.at);
  for (const ev of ordered) {
    sim.at(ev.at);
    await ev.run();
  }
}

module.exports = { createSim, runTimeline, START };
