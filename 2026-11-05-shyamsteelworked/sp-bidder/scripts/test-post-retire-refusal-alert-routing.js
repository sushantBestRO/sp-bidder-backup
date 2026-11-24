'use strict';
/**
 * Regression: E5 (post-retire refusal classes), alert payload.
 *
 * A vehicle-count refusal that resolves after a re-price retired its monitor must reach the desk
 * exactly as the same refusal does on the live path. vehicle_count_refused is a routed desk notice:
 * companyName / branchName pick the customer's group, and vcqSent is both the count the desk is told
 * and part of the notifier's dedupe key. An alert that is emitted but missing those keys goes to the
 * unscoped recipients and can be swallowed as a duplicate of an earlier count.
 *
 * The expected payload is taken from the live path on the same load, not written out by hand.
 *
 *   node scripts/test-post-retire-refusal-alert-routing.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { toNotification } = require('../src/notify/engineAlerts');

let pass = 0;
const EXPECTED_CHECKS = 3;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const REMAINING_MS = 114 * 60 * 1000;
const OPEN_AT_MS = 2 * 60 * 60 * 1000;
const ID = 'E5ROUTE';
const QUANTITY_REFUSED = { accepted: false, status: 400, reason: 'Quote quantity is greater than total quantity',
  text: 'Quote quantity is greater than total quantity' };
const ROUTING_FIELDS = ['lane', 'companyName', 'branchName', 'vcqSent', 'units'];

const liveState = () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: REMAINING_MS, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 });
const mkLoad = () => ({ id: ID, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 3,
  quoteType: 'FTL', companyName: 'Waaree Energies', branchName: 'Alwar', closesAt: Date.now() + REMAINING_MS,
  startsAt: Date.now() - 1_000, status: 'live', softClose: false });
const PRICING_A = { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 };
const PRICING_B = { cost: 27_000, marginsPct: [20, 10, 1], minMarginPct: 1 };

const cleanups = [];
const qtyAlerts = (events) => events.filter((e) => e.type === 'alert' && e.kind === 'vehicle_count_refused');
const pick = (a) => Object.fromEntries(ROUTING_FIELDS.map((k) => [k, a[k]]));
const disarm = (m) => { if (m.timer) clearTimeout(m.timer); m.timer = null; };

function mkEngine(tag, placeBid) {
  const f = path.join(os.tmpdir(), `post-retire-alert-routing-${tag}-${process.pid}.json`);
  const adapter = {
    writeEnabled: true, placed: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => liveState(),
    async placeBid(_id, price, opts) {
      this.placed.push({ price, vcq: opts && opts.vcq != null ? opts.vcq : null });
      return placeBid(this.placed.length);
    },
  };
  const engine = new BidEngine(adapter, new DurableScheduler(f), {
    config: { openAtMs: OPEN_AT_MS, floorWindowMs: 2_500, minInterFireMs: 0 }, live: true });
  const events = [];
  engine.onEvent = (e) => events.push(e);
  cleanups.push(() => { try { engine.kill(); } catch (_) {} try { fs.unlinkSync(f); } catch (_) {} });
  return { engine, adapter, events };
}

(async () => {
  // Reference: the same refusal on the live path, no retire in between.
  const ref = mkEngine('live', () => QUANTITY_REFUSED);
  const m = ref.engine.arm(mkLoad(), PRICING_A);
  disarm(m);
  await ref.engine._maybeBid(m, liveState());
  const liveAlerts = qtyAlerts(ref.events);
  assert.strictEqual(liveAlerts.length, 1, `fixture: the live path raised ${liveAlerts.length} vehicle_count_refused alerts, expected 1`);
  const expected = pick(liveAlerts[0]);
  for (const k of ROUTING_FIELDS) assert.ok(expected[k] != null, `fixture: the live-path alert carries no ${k}, so there is nothing to compare`);
  const expectedNote = toNotification(liveAlerts[0]);
  assert.strictEqual(expectedNote && expectedNote.kind, 'desk_notice', 'fixture: the live-path alert does not route as a desk notice');
  ok(`live path: one vehicle_count_refused alert, routed as a desk notice, ${JSON.stringify(expected)}`);

  // Re-price door: the refused write is held on the wire while stop() + arm() build a successor.
  let release;
  const onWire = new Promise((r) => { release = r; });
  const h = mkEngine('reprice', (n) => (n === 1 ? onWire : { accepted: true, myRank: 1, latencyMs: 30 }));
  const fired = h.engine.arm(mkLoad(), PRICING_A);
  disarm(fired);
  const inFlight = h.engine._maybeBid(fired, liveState());
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(h.adapter.placed.length, 1, 'fixture: exactly one write is on the wire');
  h.engine.stop(ID);
  const live = h.engine.arm(mkLoad(), PRICING_B);
  disarm(live);
  assert.notStrictEqual(live, fired, 'fixture: the re-price built a successor monitor');
  release(QUANTITY_REFUSED);
  await inFlight;
  assert.strictEqual(h.events.filter((e) => e.type === 'bid_rejected').length, 1,
    'fixture: the refusal resolved through the post-retire door onto the record');

  const post = qtyAlerts(h.events);
  assert.strictEqual(post.length, 1,
    `MECHANISM: the vehicle-count refusal resolved after a re-price and the desk got ${post.length} vehicle_count_refused `
    + 'alerts - the live path raises exactly one, so the one refusal the desk can fix goes unannounced');
  assert.deepStrictEqual(pick(post[0]), expected,
    'MECHANISM: the post-retire vehicle_count_refused alert does not carry the live path\'s routing and count fields '
    + `(got ${JSON.stringify(pick(post[0]))}) - without companyName/branchName no customer-scoped group matches, `
    + 'without vcqSent the desk is not told the count and the dedupe key loses it');
  const note = toNotification(post[0]);
  assert.strictEqual(note && note.kind, 'desk_notice', 'the post-retire alert does not route as a desk notice');
  for (const k of ['origin', 'shipper', 'branch', 'vcqSent', 'units']) {
    assert.strictEqual(note.data[k], expectedNote.data[k],
      `the post-retire notice resolves ${k}=${JSON.stringify(note.data[k])} where the live path resolves `
      + `${JSON.stringify(expectedNote.data[k])} - it would reach a different group or print a different count`);
  }
  assert.strictEqual(note.dedupeKey, expectedNote.dedupeKey,
    `the post-retire notice dedupes on ${note.dedupeKey}, the live path on ${expectedNote.dedupeKey}`);
  ok('re-price door: the successor raises one vehicle_count_refused alert that routes and dedupes as the live path\'s does');

  await h.engine._maybeBid(live, liveState());
  assert.strictEqual(h.adapter.placed.length, 1,
    `after the vehicle-count refusal the successor put ${h.adapter.placed.length - 1} further write(s) on the shared account `
    + `(${JSON.stringify(h.adapter.placed.slice(1))}) - the post-retire refusal did not stand it down`);
  ok('re-price door: the successor places no further write after the refusal');

  cleanups.forEach((c) => c());
  if (pass !== EXPECTED_CHECKS) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`);
    process.exit(1);
  }
  console.log(`\nPASS ${pass}/${EXPECTED_CHECKS} checks`);
  process.exit(0);
})().catch((e) => {
  cleanups.forEach((c) => c());
  console.error('\nFAILED:', e && e.stack || e);
  process.exit(1);
});
