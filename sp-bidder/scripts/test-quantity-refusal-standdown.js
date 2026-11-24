'use strict';
/**
 * QUANTITY REFUSAL - the fourth rejection class, the stand-down it takes, and the live-remaining
 * clamp that keeps that stand-down from forfeiting winnable loads.
 *
 * SuperProcure refuses some multi-vehicle bids with the plaintext body
 *     Quote quantity is greater than total quantity
 * and until this change that string matched no classifier, so it fell to the default PRICE/STATE
 * class - "this PRICE was refused, walk the ladder down and retry". The engine therefore answered a
 * QUANTITY verdict by conceding margin, repeatedly, against a wall. The cause is that `units` is the
 * load's ORIGINAL requirement while SP's loadTotalQuantity is what is still biddable and drops as
 * the shipper partially allots.
 *
 * WHAT MUST NOT MOVE, pinned as hard as the fix:
 *   - the WALK-DOWN survives for genuine price rejections. The match is narrow on purpose: an
 *     over-broad /quantity/ would swallow the PMT_QUANTITY refusal and other retryable strings.
 *   - revisionsLeft is NOT zeroed. The budget is genuinely intact, and zeroing it would hand the
 *     re-price this alert ASKS FOR a phantom exhausted load.
 *   - a CAP rejection keeps its own, different behaviour.
 *   - the two halves must not fight: the stand-down binds the COUNT, so a lower count still bids.
 *     That INTERACTION is section 10, and its absence is how the defect shipped past round 1.
 *
 * Mock policy matches test-rejection-taxonomy.js: the ONLY seam mocked is the platform adapter.
 * Decisions come from the real _decide via the real _maybeBid, and the desk copy is rendered through
 * the real waTemplates. Offline, deterministic, no timers, no network.
 *
 *   node scripts/test-quantity-refusal-standdown.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { toNotification } = require('../src/notify/engineAlerts');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');
const { createLogger } = require('../src/logging/logger');
const { numericOrNull } = require('../src/util/numericOrNull');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `qty-ref-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

// The refusal body, VERBATIM from load 23793945 (2026-08-04 05:59:32 UTC) and the three others.
// Carried on `text` because SuperProcure's body does not parse as JSON.
const QTY_BODY = 'Quote quantity is greater than total quantity';

function mkEngine(cfgOverrides, engineOpts) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
  };
  const events = [];
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), Object.assign({
    config: Object.assign({ openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 }, cfgOverrides || {}),
    onEvent: (e) => events.push(e),
  }, engineOpts || {}));
  eng._events = events;
  return eng;
}

// A logger that still writes to pm2-shaped stdout but keeps every .error line, so a test can assert
// on production TRACEABILITY - which is a real property here: the count walk-down the stand-down
// allows is invisible in prod if only the first refused write is logged.
function captureLog() {
  const real = createLogger('bidEngine');
  const errors = [];
  const log = (msg, meta) => real(msg, meta);
  log.debug = real.debug;
  log.info = real.info;
  log.warn = real.warn;
  log.force = real.force;
  log.error = (msg, meta) => { errors.push({ msg, meta }); real.error(msg, meta); };
  log.errors = errors;
  return log;
}

// Arm a HARD-close multi-vehicle monitor on a controlled ladder. quoteType FTL is what makes
// isMultiVehicle read `units` as a truck count, so _multiVehiclePlan yields vcq = units - the
// BID-MAX-ALWAYS default, and exactly the shape all four refused loads were in.
function armMulti(eng, ladder, { units = 5, bidVehicleCount = null, id = 'Q1',
  companyName = 'KEI Industries Ltd' } = {}) {
  const meta = { id, lane: { origin: 'Indi', destination: 'Maharashtra' }, units,
    quoteType: 'FTL', bidVehicleCount, equipment: 'Trailer Flat Bed (FBT)',
    companyName, branchName: 'Chopanki', closesAt: Date.now() + 600_000 };
  const m = eng.arm(meta, { cost: 106_000, marginsPct: [12.6, 7.2, 7] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = ladder.slice();
  m.floor = ladder[ladder.length - 1];
  m.closeModel = 'hard';
  m.revisionsLeft = 3;
  return m;
}

const state = (remaining, myRank, minDecrement = 100) => ({ closesInMs: remaining, myRank,
  minDecrement, standingL1Price: null, measuredRttMs: 50 });

// Programmable adapter: each placeBid pops the next outcome; past the end it repeats the last, so a
// single 'reject-qty' models the PERSISTENT refusal all four loads actually took.
function program(eng, kinds) {
  const box = { attempted: [], placed: [], calls: 0 };
  let i = 0;
  eng.adapter.placeBid = async (id, price) => {
    box.calls += 1;
    box.attempted.push(price);
    const kind = kinds[Math.min(i, kinds.length - 1)];
    i += 1;
    if (kind === 'reject-qty') {
      return { accepted: false, reason: 'rejected', status: 400, text: QTY_BODY };
    }
    if (kind === 'reject-cap') {
      return { accepted: false, reason: 'Bid limit exceeded', status: 400, text: 'Bid limit exceeded' };
    }
    if (kind === 'reject-price') {
      return { accepted: false, reason: 'Bid difference too small.', status: 400, text: 'Bid difference too small.' };
    }
    box.placed.push(price);
    return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 };
  };
  return box;
}

const alertsOfKind = (eng, kind) => eng._events.filter((e) => e.type === 'alert' && e.kind === kind);

// Drive the real _maybeBid down a countdown at the ENGINE'S OWN cadence on a virtual clock - same
// discipline as test-rejection-taxonomy.js, and load-bearing for the same two reasons (production
// cadence, and minInterFireMs/maxBidsPerMin measured against Date.now).
async function driveMaybeBid(eng, m, { from, to = 0, rank = null, maxTicks = 20_000 }) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    let r = from;
    let ticks = 0;
    while (r >= to && ticks++ < maxTicks) {
      const k = typeof rank === 'function' ? rank(m, r) : rank;
      await eng._maybeBid(m, state(r, k));
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
}

(async () => {
  // ---------------------------------------------------------------- 1. the classifier itself
  {
    // Reached through the engine rather than by exporting the predicate: the classifier is internal,
    // and what matters is that THE ENGINE latches on the real string and not on its neighbours.
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420]);
    program(eng, ['reject-qty']);
    await driveMaybeBid(eng, m, { from: 30_000, to: 0 });
    assert.strictEqual(m.quantityRefused, true, 'the exact SP body must latch quantityRefused');
    ok('the verbatim SuperProcure body latches the quantity stand-down');
  }
  {
    // NARROWNESS. These are real SuperProcure refusals that contain "quantity" or "greater than"
    // but are NOT the quantity verdict, and every one of them must stay retryable. An over-broad
    // regex here silently forfeits winnable auctions - the same failure mode LOAD_NOT_BIDDABLE_RE
    // was deliberately written narrow to avoid.
    const NEIGHBOURS = [
      'PMT_QUANTITY',
      'Amount is greater than ceiling price',
      'Load is under approval for allotment. Bidding is not allowed.',
      'Auction has already ended for this load',
      'Bid difference too small.',
    ];
    for (const body of NEIGHBOURS) {
      const eng = mkEngine();
      const m = armMulti(eng, [119356, 113632, 113420], { id: `N-${body.slice(0, 6)}` });
      eng.adapter.placeBid = async () => ({ accepted: false, reason: 'rejected', status: 400, text: body });
      await driveMaybeBid(eng, m, { from: 30_000, to: 0 });
      assert.strictEqual(m.quantityRefused, false,
        `"${body}" must NOT be read as the quantity refusal`);
    }
    ok('five neighbouring SuperProcure refusals do NOT latch it (narrow match preserved)');
  }

  // ---------------------------------------------------------------- 2. the stand-down
  {
    // THE HEADLINE, in the shape the box actually recorded: hard close, three-rung ladder,
    // persistent quantity refusal. Before the fix the engine walked all three rungs and then
    // re-fired the floor repeatedly inside the final window. After it, one write and stop.
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420]);
    const box = program(eng, ['reject-qty']);
    await driveMaybeBid(eng, m, { from: 30_000, to: 0 });
    assert.strictEqual(box.calls, 1,
      `a quantity refusal must stop at ONE wire write, got ${box.calls} (${box.attempted.join(', ')})`);
    assert.deepStrictEqual(box.placed, [], 'nothing may land');
    ok('ONE wire write, not nine - the ladder walk-down and the floor re-fires are both stopped');
  }
  {
    // The floor snipe specifically. It lives BELOW the ladder gates, which is why the stand-down has
    // to sit above every gate in _maybeBid rather than inside the ladder logic: a guard placed lower
    // would still let the last-chance shot through into a load SP has already refused.
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420]);
    const box = program(eng, ['reject-qty']);
    await driveMaybeBid(eng, m, { from: 30_000, to: 0 });
    assert.ok(!box.attempted.includes(113420) || box.attempted.length === 1,
      'the reserved floor rung must not be released after a quantity refusal');
    assert.strictEqual(box.calls, 1, 'no last-chance floor snipe after the stand-down');
    ok('the last-chance floor snipe does not fire after a quantity refusal');
  }

  // ---------------------------------------------------------------- 3. what must NOT change
  {
    // The budget is intact and must STAY intact. The desk notice asks the operator to re-price at a
    // lower count; if this zeroed revisionsLeft the way the CAP path does, that re-price would
    // inherit a phantom exhausted load and place nothing.
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420]);
    program(eng, ['reject-qty']);
    await driveMaybeBid(eng, m, { from: 30_000, to: 0 });
    assert.strictEqual(m.revisionsLeft, 3, 'revisionsLeft must be untouched (budget is intact)');
    assert.strictEqual(m.capExhausted, false, 'this is not a cap rejection');
    assert.strictEqual(m.loadNotBiddable, false, 'this is not the load-not-biddable class');
    ok('revisionsLeft is NOT zeroed and neither neighbouring latch is set');
  }

  // ---------------------------------------------------------------- 4. the desk gets told, once
  {
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420], { units: 5 });
    program(eng, ['reject-qty']);
    await driveMaybeBid(eng, m, { from: 30_000, to: 0 });
    const alerts = alertsOfKind(eng, 'vehicle_count_refused');
    assert.strictEqual(alerts.length, 1, `expected exactly one alert, got ${alerts.length}`);
    const a = alerts[0];
    assert.strictEqual(a.vcqSent, 5, 'the alert must carry the count we actually sent');
    assert.strictEqual(a.units, 5, 'the alert must carry the load total');
    assert.strictEqual(a.want, 5, 'and the desk commitment, in the same vocabulary as its siblings');
    // The SCOPE keys. Without a shipper on the payload no customer group can match, and the notice
    // lands nowhere - the exact defect ceiling_below_floor was moved onto this channel to fix.
    assert.strictEqual(a.companyName, 'KEI Industries Ltd', 'scope key: shipper');
    assert.strictEqual(a.branchName, 'Chopanki', 'scope key: branch');
    assert.ok(a.lane && a.lane.origin, 'scope key: lane');
    ok('exactly ONE desk alert, carrying the count, the load total and the scope keys');
  }
  {
    // A desk-lowered count must be reported as what WENT OUT, not as the load total - otherwise the
    // notice tells the desk to lower a number they already lowered.
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420], { units: 5, bidVehicleCount: 3, id: 'Q-partial' });
    program(eng, ['reject-qty']);
    await driveMaybeBid(eng, m, { from: 30_000, to: 0 });
    const a = alertsOfKind(eng, 'vehicle_count_refused')[0];
    assert.strictEqual(a.vcqSent, 3, 'a desk-chosen partial must be reported as the count sent');
    assert.strictEqual(a.units, 5, 'the load total is still reported alongside it');
    assert.strictEqual(a.want, 3, 'and want is the desk-chosen count, not the load total');
    ok('a desk-lowered count is reported as sent (3), distinctly from the load total (5)');
  }

  // ---------------------------------------------------------------- 5. it routes as a DESK notice
  {
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420]);
    program(eng, ['reject-qty']);
    await driveMaybeBid(eng, m, { from: 30_000, to: 0 });
    const n = toNotification(alertsOfKind(eng, 'vehicle_count_refused')[0]);
    assert.strictEqual(n.kind, 'desk_notice',
      'must route as a desk notice, not an ops error - the desk is the only party who can act on it');
    assert.strictEqual(n.data.shipper, 'KEI Industries Ltd', 'scope survives into the notification');
    assert.strictEqual(n.data.vcqSent, 5, 'the count survives into the notification');
    const body = renderMessage(templateFor(n.kind), n.data);
    // The three things the message has to do: absolve the rate, name the count, ask for the ONE
    // action that works. Asserted on rendered output because that is what the Director reads.
    assert.ok(/5 trucks/.test(body), `rendered notice must name the count:\n${body}`);
    assert.ok(/rate was not the problem/i.test(body), `must absolve the rate:\n${body}`);
    assert.ok(/lower how many trucks/i.test(body), `must ask for the count change:\n${body}`);
    assert.ok(!/cannot be bid/i.test(body),
      `must NOT claim the load is unbiddable - it can be bid at a lower count:\n${body}`);
    // WhatsApp copy discipline: no em dashes anywhere in a desk-facing message.
    assert.ok(!body.includes('—'), `no em dashes in WhatsApp copy:\n${body}`);
    // 2026-09-16 length trim: the client flagged this notice as too long.
    assert.ok(!/on this load - it says the quantity/i.test(body), 'and drops the old wordier opening');
    ok('renders a desk notice that names the count, absolves the rate and asks for the fix');
  }

  // ---------------------------------------------------------------- 6. the close-time receipt
  {
    // Without a recorded refusal this close fell through to NO_BID_REASON_UNKNOWN - "A rate was
    // entered but no bid could be placed" - which points the desk at a pricing mistake that does not
    // exist. On these loads the rate was fine and went out; the COUNT was refused.
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420]);
    program(eng, ['reject-qty']);
    await driveMaybeBid(eng, m, { from: 30_000, to: 0 });
    assert.ok(m.noBid, 'a refusal must be recorded for the close-time receipt');
    assert.strictEqual(m.noBid.reason, 'vehicle_count_refused');
    assert.strictEqual(m.noBid.vcqSent, 5, 'the recorded refusal carries the count');
    // A zero-landed-bid close routes 'lost' -> the 'no_bid' template, which is where noBidWhy is
    // rendered. Selected through the real templateFor so the test exercises the same branch the
    // notifier takes rather than hardcoding a template name that could drift.
    const payload = {
      result: 'lost', oaNo: 'Q1', shipper: 'KEI Industries Ltd', origin: 'Indi', dest: 'Maharashtra',
      lane: 'Indi -> Maharashtra', landedBids: 0,
      noBidReason: m.noBid.reason, noBidVcqSent: m.noBid.vcqSent,
    };
    const tpl = templateFor('lost', payload);
    assert.strictEqual(tpl, 'no_bid', 'a zero-landed-bid close must select the no_bid template');
    const receipt = renderMessage(tpl, payload);
    assert.ok(/quantity is more than the load allows/i.test(receipt),
      `the close receipt must name the quantity cause:\n${receipt}`);
    assert.ok(!/A rate was entered but no bid could be placed/i.test(receipt),
      `must NOT fall back to the misleading generic:\n${receipt}`);
    ok('the close-time receipt names the quantity cause instead of the generic no-bid wording');
  }

  // ---------------------------------------------------------------- 7. the instrumentation gap
  {
    // bid_rejected records on the JSONL stream carried no rungIndex, so a refusal could not be tied
    // to a ladder position after the fact and repeats of one rung read as distinct attempts.
    const { BidLogger } = require('../src/logging/bidLogger');
    const { MemoryStore } = require('../src/store');
    const store = new MemoryStore();
    const logger = new BidLogger({ store });
    await logger._onRejected({ auctionId: 'Q9', price: 113420, carrierSent: 5963, status: 400,
      reason: 'rejected', body: QTY_BODY, rungIndex: 2, ts: 1785823197852 });
    const evs = await store.readEvents('bids');
    const rej = evs.filter((e) => e.kind === 'bid_rejected');
    assert.strictEqual(rej.length, 1);
    assert.strictEqual(rej[0].rungIndex, 2,
      'the un-backfillable jsonl stream must carry the rung the refusal was taken on');
    assert.strictEqual(rej[0].httpStatus, 400, 'and the normalised http status');
    ok('bid_rejected on the jsonl stream now carries rungIndex (was dropped since #26)');
  }

  // ---------------------------------------------------------------- 8. the walk-down still works
  {
    // THE GUARD AGAINST OVER-REACH. A persistent genuine PRICE rejection must still walk the whole
    // ladder to the floor. This is the check whose absence would let a too-broad classifier through.
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420], { id: 'Q-price' });
    const box = program(eng, ['reject-price']);
    await driveMaybeBid(eng, m, { from: 30_000, to: 0 });
    assert.ok(box.calls > 1, 'a price rejection must still retry');
    assert.ok(box.attempted.includes(113420),
      `the walk-down must still reach the floor, got ${box.attempted.join(', ')}`);
    assert.strictEqual(m.quantityRefused, false, 'and must not latch the quantity stand-down');
    ok('a persistent PRICE rejection still walks the ladder down to the floor');
  }
  {
    // And the CAP class keeps its own, different behaviour: terminal, and it DOES zero the budget.
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420], { id: 'Q-cap' });
    program(eng, ['reject-cap']);
    await driveMaybeBid(eng, m, { from: 30_000, to: 0 });
    assert.strictEqual(m.capExhausted, true, 'cap still latches');
    assert.strictEqual(m.revisionsLeft, 0, 'cap still zeroes the budget');
    assert.strictEqual(m.quantityRefused, false, 'and is not confused with the quantity class');
    ok('the CAP class is unchanged: terminal, and it still zeroes revisionsLeft');
  }

  // ---------------------------------------------------------- 9. the LIVE REMAINING QUANTITY clamp
  // THE ROOT-CAUSE FIX: bid what SuperProcure still has open, not what the load originally asked for.
  {
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420], { units: 5, id: 'C-clamp' });
    // Unknown remaining -> today's behaviour, unchanged. This is the compatibility guarantee for
    // the mock, the sim and any adapter that does not surface the field.
    assert.deepStrictEqual(eng._multiVehiclePlan(m, { closesInMs: 30_000 }), { vcq: 5, want: 5, remaining: null });
    assert.deepStrictEqual(eng._multiVehiclePlan(m, { remainingQuantity: null }), { vcq: 5, want: 5, remaining: null });
    assert.deepStrictEqual(eng._multiVehiclePlan(m), { vcq: 5, want: 5, remaining: null });
    // Remaining at or above what we want -> no-op, and NOT flagged as clamped.
    assert.deepStrictEqual(eng._multiVehiclePlan(m, { remainingQuantity: 5 }), { vcq: 5, want: 5, remaining: 5 });
    assert.deepStrictEqual(eng._multiVehiclePlan(m, { remainingQuantity: 9 }), { vcq: 5, want: 5, remaining: 9 });
    // A genuine shortfall -> bid for what is left, flagged, with both numbers for the desk notice.
    const p = eng._multiVehiclePlan(m, { remainingQuantity: 2 });
    assert.strictEqual(p.vcq, 2, 'must bid the remaining quantity, not the original count');
    assert.strictEqual(p.clamped, true);
    assert.strictEqual(p.want, 5);
    assert.strictEqual(p.remaining, 2);
    // A fractional remaining floors rather than sending a fraction - assertValidVcq rejects those.
    assert.strictEqual(eng._multiVehiclePlan(m, { remainingQuantity: 2.7 }).vcq, 2);
    // Nothing left -> hold. Not a smaller bid; there is no quantity that can be quoted at all.
    const h = eng._multiVehiclePlan(m, { remainingQuantity: 0 });
    assert.strictEqual(h.hold, true);
    assert.strictEqual(h.reason, 'no_quantity_remaining');
    // NEGATIVE is unknown, not zero. SP has no meaning for a below-zero remaining, so one can only
    // be malformed - and the two readings are not symmetrical. Unknown keeps bid-max and makes no
    // claim; zero holds a winnable load AND tells the customer it was given out. Reading a
    // malformed field as zero is the only one of the two that can be wrong out loud.
    for (const neg of [-1, -0.5, -22, -1e9]) {
      const p2 = eng._multiVehiclePlan(m, { remainingQuantity: neg });
      assert.strictEqual(p2.vcq, 5, `remaining ${neg} must read UNKNOWN and keep bid-max`);
      assert.strictEqual(p2.remaining, null, `remaining ${neg} must not be reported as a count`);
      assert.ok(!p2.hold, `remaining ${neg} must NOT hold the load`);
    }
    ok('vcq clamps to the LIVE remaining quantity; unknown keeps bid-max, zero holds, negative is unknown');
  }
  {
    // The clamp must respect the desk's own lowered count as the CEILING - it can only ever reduce
    // further, never raise a desk-chosen 2 back up because SP has 5 left.
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420], { units: 5, bidVehicleCount: 2, id: 'C-desk' });
    assert.deepStrictEqual(eng._multiVehiclePlan(m, { remainingQuantity: 5 }), { vcq: 2, want: 2, remaining: 5 },
      'a desk-chosen 2 stays 2 even when SP has 5 remaining');
    assert.strictEqual(eng._multiVehiclePlan(m, { remainingQuantity: 1 }).vcq, 1,
      'and still clamps below the desk count when SP has less');
    ok('the clamp only ever lowers - a desk-chosen count is never raised by a larger remaining');
  }
  {
    // End to end through the real _maybeBid: the wire gets the clamped count, the bid LANDS (this is
    // the whole point - it wins a load that would otherwise have been refused outright), and the
    // desk is told once that their commitment shrank.
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420], { units: 5, id: 'C-e2e' });
    const sent = [];
    eng.adapter.placeBid = async (id, price, opts) => {
      sent.push(opts && opts.vcq);
      return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 };
    };
    const REAL_NOW = Date.now; let vnow = REAL_NOW(); Date.now = () => vnow;
    try {
      await eng._maybeBid(m, Object.assign(state(20_000, null), { remainingQuantity: 2 }));
    } finally { Date.now = REAL_NOW; }
    assert.deepStrictEqual(sent, [2], `the wire must carry the clamped count, got ${sent.join(',')}`);
    const cl = alertsOfKind(eng, 'vehicle_count_clamped');
    assert.strictEqual(cl.length, 1, 'the desk is told exactly once');
    assert.strictEqual(cl[0].want, 5);
    assert.strictEqual(cl[0].remaining, 2);
    const n = toNotification(cl[0]);
    assert.strictEqual(n.kind, 'desk_notice');
    const body = renderMessage(templateFor(n.kind), n.data);
    // It must NOT read as a refusal - we bid, and we can still win this load.
    assert.ok(!/Not bidding/i.test(body), `a placed bid must not read as a refusal:\n${body}`);
    assert.ok(/2 trucks are still open instead of 5/.test(body), `must state both counts:\n${body}`);
    assert.ok(!body.includes('—'), 'no em dashes in WhatsApp copy');
    ok('end to end: the clamped count reaches the wire, lands, and the desk is told once');
  }
  {
    // The no-numbers fallback (want/remaining unavailable) - a separate desk_notice rendering the
    // above end-to-end case never exercises. 2026-09-16 length trim: the client flagged this one too.
    const body = renderMessage('desk_notice', { reason: 'vehicle_count_clamped',
      shipper: 'KEI Industries Ltd', auctionId: 23803049, lane: 'Bharuch -> Pune' });
    assert.ok(/already given out/i.test(body), 'still says the customer already gave out part of the load');
    assert.ok(/same rate per truck/i.test(body), 'still states the same-rate-per-truck fact');
    assert.ok(/nothing to do/i.test(body), 'still carries the reassurance the desk has nothing to do');
    assert.ok(!/we will let you know the result/i.test(body), 'and drops the old wordier closing');
    assert.ok(!body.includes('—'), 'no em dashes in WhatsApp copy');
    ok('the no-numbers clamp notice keeps the load-bearing facts in trimmed form');
  }
  {
    // The fully-allotted hold: no bid, a recorded refusal so the close receipt can explain it, and
    // desk copy that does not send anyone hunting a pricing mistake.
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420], { units: 5, id: 'C-gone' });
    const box = program(eng, ['ok']);
    const REAL_NOW = Date.now; let vnow = REAL_NOW(); Date.now = () => vnow;
    try {
      await eng._maybeBid(m, Object.assign(state(20_000, null), { remainingQuantity: 0 }));
    } finally { Date.now = REAL_NOW; }
    assert.strictEqual(box.calls, 0, 'nothing may go on the wire when nothing is left to bid for');
    assert.strictEqual(m.noBid && m.noBid.reason, 'no_quantity_remaining');
    const gone = alertsOfKind(eng, 'no_quantity_remaining');
    assert.strictEqual(gone.length, 1);
    const body = renderMessage(templateFor('desk_notice'), toNotification(gone[0]).data);
    assert.ok(/nothing left to bid for/i.test(body), `must say the load is gone:\n${body}`);
    assert.ok(!/quote it on SuperProcure/i.test(body),
      `must NOT fall through to the generic "quote it manually" copy:\n${body}`);
    ok('a fully-allotted load holds, records the reason, and gets its own desk copy');
  }

  // ------------------------------------------- 10. the STAND-DOWN meets the CLAMP (the interaction)
  // The two halves of this change were tested separately and their INTERACTION was the defect: the
  // stand-down sat above the clamp and pre-empted it on exactly the load population the clamp
  // exists to rescue. The ordinary sequence is shipper-allots-at-t=5s, loadMeta is a ~30s poll
  // behind, so the tick that fires still bids the full count and is refused - and the refreshed
  // listing then produces a count SuperProcure has never ruled on.
  {
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420], { units: 5, id: 'Q-lower' });
    const sent = [];
    let refuse = true;
    eng.adapter.placeBid = async (id, price, opts) => {
      sent.push(opts && opts.vcq != null ? opts.vcq : null);
      if (refuse) return { accepted: false, reason: 'rejected', status: 400, text: QTY_BODY };
      return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 };
    };
    const REAL_NOW = Date.now; let vnow = REAL_NOW(); Date.now = () => vnow;
    try {
      // Remaining unknown (the stale-loadMeta tick) -> bid-max 5 -> refused -> latched AT 5.
      await eng._maybeBid(m, state(20_000, null));
      assert.deepStrictEqual(sent, [5], `the first fire must go at bid-max, got ${sent.join(',')}`);
      assert.strictEqual(m.quantityRefused, true, 'the refusal latches');
      assert.strictEqual(m.quantityRefusedAtVcq, 5, 'and it latches at the count SP actually ruled on');
      // A count SP HAS ruled on must never be re-sent - unknown, equal, or higher remaining alike.
      vnow += 1_000; await eng._maybeBid(m, state(19_000, null));
      vnow += 1_000; await eng._maybeBid(m, Object.assign(state(18_000, null), { remainingQuantity: 5 }));
      vnow += 1_000; await eng._maybeBid(m, Object.assign(state(17_000, null), { remainingQuantity: 9 }));
      assert.deepStrictEqual(sent, [5], `a count at or above the refused one may not be re-sent, got ${sent.join(',')}`);
      // The refreshed listing lands: SP now has 2 left. That is a quantity SP has never ruled on.
      refuse = false;
      vnow += 1_000; await eng._maybeBid(m, Object.assign(state(16_000, null), { remainingQuantity: 2 }));
      assert.deepStrictEqual(sent, [5, 2], `a strictly LOWER count earns one attempt, got ${sent.join(',')}`);
      assert.strictEqual(m.landedBids, 1, 'and it lands - this is the load the clamp exists to rescue');
      // An accepted bid retires the verdict, or the load would freeze with its ladder unspendable.
      assert.strictEqual(m.quantityRefused, false, 'an accepted count clears the stand-down');
      assert.strictEqual(m.quantityRefusedAtVcq, null, 'and clears the latched count with it');
    } finally { Date.now = REAL_NOW; }
    ok('a refusal then a LOWERED remaining quantity earns exactly one attempt, and it lands');
  }
  {
    // BOUNDED, AND THE TWO DESK SURFACES AGREE. The retry is not a loop: each refusal re-latches at
    // the count just refused, and the latch only ever moves DOWN, so the walk is bounded by the count
    // itself. The desk hears about it once PER COUNT, not once per load: the record is
    // last-writer-wins, so a fact-latched alert would leave the real-time notice naming 5 while the
    // close-time receipt named 3 for the identical auction, and would tell the desk to "lower how
    // many trucks" after the engine had already walked the count down itself. Every refused write is
    // logged too, or the whole retry sequence is one line in production.
    const eng = mkEngine(null, { log: captureLog() });
    const m = armMulti(eng, [119356, 113632, 113420], { units: 5, id: 'Q-bounded' });
    const sent = [];
    eng.adapter.placeBid = async (id, price, opts) => {
      sent.push(opts && opts.vcq != null ? opts.vcq : null);
      return { accepted: false, reason: 'rejected', status: 400, text: QTY_BODY };
    };
    const REAL_NOW = Date.now; let vnow = REAL_NOW(); Date.now = () => vnow;
    try {
      await eng._maybeBid(m, state(20_000, null));
      for (const ms of [19_000, 18_000, 17_000, 16_000]) {
        vnow += 1_000;
        await eng._maybeBid(m, Object.assign(state(ms, null), { remainingQuantity: 3 }));
      }
    } finally { Date.now = REAL_NOW; }
    assert.deepStrictEqual(sent, [5, 3], `each distinct lower count gets ONE write, got ${sent.join(',')}`);
    assert.strictEqual(m.quantityRefusedAtVcq, 3, 'the latch re-tightens to the count just refused');
    const refused = alertsOfKind(eng, 'vehicle_count_refused');
    assert.strictEqual(refused.length, 2,
      `a strictly LOWER refused count must re-alert, got ${refused.length}`);
    assert.strictEqual(refused[0].vcqSent, 5, 'the first notice names the first count refused');
    assert.strictEqual(refused[1].vcqSent, 3, 'the second names the NEW count, not the first');
    assert.strictEqual(m.noBid.vcqSent, 3,
      'and the record names the same count as the last alert, not a different one');
    const rKeys = refused.map((e) => toNotification(e).dedupeKey);
    assert.notStrictEqual(rKeys[0], rKeys[1],
      `the notifier would swallow the follow-up on a shared dedupeKey: ${rKeys.join(' / ')}`);
    const refusalLogs = eng.log.errors.filter((l) => /quoted vehicle count exceeds the load total/.test(l.msg));
    assert.strictEqual(refusalLogs.length, 2,
      `every refused write must be traceable, got ${refusalLogs.length} log line(s) for 2 refusals`);
    assert.deepStrictEqual(refusalLogs.map((l) => l.meta.vcqSent), [5, 3],
      'and each line carries the count that write actually sent');
    ok('the lower-count retry is bounded: one write, one alert and one log line per distinct count');
  }

  // ------------------------------------------- 11. the clamp notice is a MONEY CLAIM, made at the wire
  {
    // "We have bid for N" may only be said where money actually moved. Emitted at the top of
    // _maybeBid it preceded every downstream gate: revisionsLeft, minInterFireMs, the rate cap and
    // a _decide that can return null. Concrete trigger - revisionsLeft already 0 on the tick the
    // clamp is first seen: the notice went out and the very next check returned, so no bid was ever
    // placed and the one-shot latch meant it never re-fired.
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420], { units: 5, id: 'C-nobid' });
    m.revisionsLeft = 0;
    const box = program(eng, ['ok']);
    const REAL_NOW = Date.now; let vnow = REAL_NOW(); Date.now = () => vnow;
    try {
      await eng._maybeBid(m, Object.assign(state(20_000, null), { remainingQuantity: 2 }));
    } finally { Date.now = REAL_NOW; }
    assert.strictEqual(box.calls, 0, 'nothing went on the wire');
    assert.strictEqual(alertsOfKind(eng, 'vehicle_count_clamped').length, 0,
      'so the desk must NOT be told we bid');
    ok('no clamp notice when the tick ends without a bid (the money claim needs a wire write)');
  }
  {
    // The latch is on the COUNT, not the fact. A load can clamp 5 -> 3 -> 2 in one auction and each
    // value really does go on the wire, so a boolean latch leaves the desk holding the first number
    // while we bid the third. The notifier's own dedupeKey has to fold the count in too, or it
    // swallows the follow-up before anyone sees it.
    const eng = mkEngine();
    // Four rungs, not three: the floor rung is reserved for the decisive shot until the last-chance
    // window, so a three-rung ladder simply holds the third fire and the repeat tick proves nothing.
    const m = armMulti(eng, [119356, 116000, 113632, 113420], { units: 5, id: 'C-again' });
    const sent = [];
    eng.adapter.placeBid = async (id, price, opts) => {
      sent.push(opts && opts.vcq != null ? opts.vcq : null);
      return { accepted: true, myRank: 2, revisionsLeft: 9, latencyMs: 20 };
    };
    const REAL_NOW = Date.now; let vnow = REAL_NOW(); Date.now = () => vnow;
    try {
      for (const [ms, left] of [[20_000, 3], [19_000, 2], [18_000, 2]]) {
        await eng._maybeBid(m, Object.assign(state(ms, 2), { remainingQuantity: left }));
        vnow += 1_000;
      }
    } finally { Date.now = REAL_NOW; }
    assert.deepStrictEqual(sent, [3, 2, 2], `each clamp value must reach the wire, got ${sent.join(',')}`);
    const cl = alertsOfKind(eng, 'vehicle_count_clamped');
    assert.strictEqual(cl.length, 2, `a further clamp must re-alert, got ${cl.length}`);
    assert.strictEqual(cl[0].remaining, 3);
    assert.strictEqual(cl[1].remaining, 2, 'the second notice carries the NEW count, not the first');
    const keys = cl.map((e) => toNotification(e).dedupeKey);
    assert.notStrictEqual(keys[0], keys[1],
      `the notifier would swallow the follow-up on a shared dedupeKey: ${keys.join(' / ')}`);
    ok('a further clamp re-alerts with the new count, on its own dedupeKey');
  }

  // ------------------------------------------- 12. "No bid was placed" on a load that HOLDS a bid
  {
    // Remaining reaching zero BECAUSE the shipper allotted is the expected way for it to reach zero,
    // and the allotment may be ours. This copy goes to the CUSTOMER'S own group, so claiming no bid
    // was placed while our bid stands on the board is the wrong claim in the wrong room. The
    // close-time sibling has always been guarded on landedBids; this emit site now is too.
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420], { units: 5, id: 'C-stands' });
    const sent = [];
    eng.adapter.placeBid = async (id, price, opts) => {
      sent.push(opts && opts.vcq != null ? opts.vcq : null);
      return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 };
    };
    const REAL_NOW = Date.now; let vnow = REAL_NOW(); Date.now = () => vnow;
    try {
      await eng._maybeBid(m, Object.assign(state(20_000, null), { remainingQuantity: 2 }));
      vnow += 1_000;
      await eng._maybeBid(m, Object.assign(state(19_000, 1), { remainingQuantity: 0 }));
    } finally { Date.now = REAL_NOW; }
    assert.deepStrictEqual(sent, [2], 'the fully-allotted tick sends nothing further');
    assert.strictEqual(m.landedBids, 1, 'but a bid of ours is standing');
    assert.strictEqual(m.noBid, null,
      'so no no-bid refusal may be recorded - it would put a false cause on the close receipt');
    const gone = alertsOfKind(eng, 'no_quantity_remaining');
    assert.strictEqual(gone.length, 1);
    assert.strictEqual(gone[0].landedBids, 1, 'the alert carries the participation fact');
    const body = renderMessage(templateFor('desk_notice'), toNotification(gone[0]).data);
    assert.ok(!/No bid was placed/i.test(body), `must not claim no bid on a load holding one:\n${body}`);
    assert.ok(!/Not bidding/i.test(body), `and the headline must not either:\n${body}`);
    assert.ok(/bid is still standing/i.test(body), `must say our bid stands:\n${body}`);
    assert.ok(!body.includes('—'), 'no em dashes in WhatsApp copy');
    ok('a fully-allotted load that HOLDS our bid gets honest copy, not "No bid was placed"');
  }

  // ------------------------------------------- 13. the close-time receipt for a fully-allotted load
  {
    // The desk_notice half of this pair was covered from the start; the close-time half was not, so
    // a drift in noBidWhy would have fallen silently back to NO_BID_REASON_UNKNOWN - "A rate was
    // entered but no bid could be placed" - which sends the desk hunting a pricing mistake.
    const payload = {
      result: 'lost', oaNo: 'C-gone', shipper: 'KEI Industries Ltd', origin: 'Indi', dest: 'Maharashtra',
      lane: 'Indi -> Maharashtra', landedBids: 0, noBidReason: 'no_quantity_remaining',
    };
    const tpl = templateFor('lost', payload);
    assert.strictEqual(tpl, 'no_bid', 'a zero-landed-bid close must select the no_bid template');
    const receipt = renderMessage(tpl, payload);
    assert.ok(/given out this whole load/i.test(receipt), `must name the cause:\n${receipt}`);
    assert.ok(/rate was not the problem/i.test(receipt), `must absolve the rate:\n${receipt}`);
    assert.ok(!/A rate was entered but no bid could be placed/i.test(receipt),
      `must NOT fall back to the misleading generic:\n${receipt}`);
    ok('the close-time receipt for a fully-allotted load names the cause');
  }

  // ------------------------------------------- 14. unknown-vs-zero on a malformed remaining
  {
    // Number.isFinite(Number(x)) is TRUE for '', ' ', false and [] - every one of which coerces to
    // 0 and would therefore read as "fully allotted": hold the bid, and tell the customer their
    // load was given out, off a malformed field. Unknown is the only honest reading, and it is also
    // the one that keeps a winnable load winnable.
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420], { units: 5, id: 'C-junk' });
    for (const junk of ['', ' ', false, true, [], {}, 'abc', NaN, Infinity]) {
      const p = eng._multiVehiclePlan(m, { remainingQuantity: junk });
      assert.ok(!p.hold, `${JSON.stringify(junk)} must not read as a fully-allotted load`);
      assert.strictEqual(p.vcq, 5, `${JSON.stringify(junk)} must read as UNKNOWN and keep bid-max`);
      assert.strictEqual(p.remaining, null, `${JSON.stringify(junk)} must report remaining unknown`);
    }
    // A genuine numeric STRING is still honoured - SuperProcure sends numbers as strings elsewhere.
    assert.strictEqual(eng._multiVehiclePlan(m, { remainingQuantity: '2' }).vcq, 2);
    assert.strictEqual(eng._multiVehiclePlan(m, { remainingQuantity: '0' }).hold, true);
    ok('a non-numeric remaining reads as UNKNOWN (bid-max), never as a fully-allotted zero');
  }

  // -------------- 15. a fully-allotted hold must not overwrite a terminal refusal already recorded
  {
    // _recordRefusal is last-writer-wins, and the no_quantity_remaining branch RETURNS above _decide -
    // the ONE site that re-asserts ceiling_below_floor, which it does on every tick precisely because
    // close time has to read it. Unguarded, a load that never bid because the shipper's cap sat under
    // our floor has its cause replaced the moment the shipper allots the load out, and the customer's
    // own group is told the rate was not the problem with the ceiling and floor numbers gone.
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420], { units: 5, id: 'C-ceil' });
    m.ceilingBelowFloor = true;
    m.ceiling = 50_000;
    const box = program(eng, ['ok']);
    const REAL_NOW = Date.now; let vnow = REAL_NOW(); Date.now = () => vnow;
    try {
      // Still open: _decide stands down on the ceiling and records it, as it does on every tick.
      await eng._maybeBid(m, Object.assign(state(20_000, null), { remainingQuantity: 5 }));
      assert.strictEqual(m.noBid && m.noBid.reason, 'ceiling_below_floor', 'the ceiling stand-down records first');
      assert.strictEqual(m.noBid.ceiling, 50_000, 'with the number the desk needs to re-price');
      // The shipper allots the load out from under us. Nothing about the ceiling has changed.
      vnow += 1_000;
      await eng._maybeBid(m, Object.assign(state(19_000, null), { remainingQuantity: 0 }));
    } finally { Date.now = REAL_NOW; }
    assert.strictEqual(box.calls, 0, 'a ceiling-blocked load never bids');
    assert.strictEqual(m.noBid.reason, 'ceiling_below_floor',
      'the fully-allotted hold must not overwrite the terminal cause already recorded');
    assert.strictEqual(m.noBid.ceiling, 50_000, 'and the ceiling must survive with it');
    assert.strictEqual(m.noBid.floor, 113420, 'and the floor, or the desk cannot re-price from the receipt');
    // The desk notice still fires - only the close-time CAUSE is protected, not the alert.
    assert.strictEqual(alertsOfKind(eng, 'no_quantity_remaining').length, 1,
      'the desk is still told the load went away');
    const payload = {
      result: 'lost', oaNo: 'C-ceil', shipper: 'KEI Industries Ltd', origin: 'Indi', dest: 'Maharashtra',
      lane: 'Indi -> Maharashtra', landedBids: 0, noBidReason: m.noBid.reason,
      noBidCeiling: m.noBid.ceiling, noBidFloor: m.noBid.floor,
    };
    const receipt = renderMessage(templateFor('lost', payload), payload);
    assert.ok(/ceiling/i.test(receipt) && /50,000/.test(receipt),
      `the close receipt must still name the ceiling:\n${receipt}`);
    assert.ok(!/given out this whole load/i.test(receipt),
      `and must not blame the allotment for a stand-down taken on price:\n${receipt}`);
    ok('a fully-allotted hold does not overwrite an already-recorded ceiling stand-down');
  }

  // ---------------------------- 16. a refusal that sent NO count is the other half of the alert rule
  {
    // The count latch must not turn "never alerted" into "alerted at null" and start re-firing on a
    // load whose refusals carry no count at all. A single-vehicle load sends no vcq, so the stand-down
    // gate stands it down outright and exactly one alert is the whole story.
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420], { units: 1, id: 'Q-single' });
    const box = program(eng, ['reject-qty']);
    await driveMaybeBid(eng, m, { from: 30_000, to: 0 });
    const refused = alertsOfKind(eng, 'vehicle_count_refused');
    assert.strictEqual(refused.length, 1, `a countless refusal alerts exactly once, got ${refused.length}`);
    assert.strictEqual(refused[0].vcqSent, null, 'and reports no count rather than inventing one');
    assert.strictEqual(box.calls, 1, 'and the load stands down after one write');
    assert.ok(toNotification(refused[0]).dedupeKey.endsWith('_vehicle_count_refused'),
      'with the bare kind key - there is no count to fold into it');
    ok('a refusal that sent no count alerts exactly once and keeps the bare dedupeKey');
  }

  // ------------------ 17. the TRANSPORT-FAILURE landing path draws the same conclusions as an accept
  {
    // The catch block is the fail-closed "assume it landed" path: `landed` defaults true, landedBids
    // is incremented and everBid is persisted. Everything that follows from a landed bid has to
    // follow here too, or the engine keeps a stand-down engaged on a load it just counted a bid for,
    // says nothing about a commitment it reduced, and believes it holds budget SP has already spent.
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420], { units: 5, id: 'C-throw' });
    const sent = [];
    let throwNext = false;
    eng.adapter.placeBid = async (id, price, opts) => {
      sent.push(opts && opts.vcq != null ? opts.vcq : null);
      // A plain Error, NOT code AUTH - the auth sentinel leaves the handler before this path.
      if (throwNext) throw new Error('socket hang up');
      return { accepted: false, reason: 'rejected', status: 400, text: QTY_BODY };
    };
    eng.adapter.getAuctionState = async () => ({ ok: false }); // no authoritative revisionsLeft, as in prod
    const REAL_NOW = Date.now; let vnow = REAL_NOW(); Date.now = () => vnow;
    try {
      // Refused at bid-max 5, so the stand-down latches AT 5 and a lower count still earns one try.
      await eng._maybeBid(m, state(20_000, null));
      assert.strictEqual(m.quantityRefusedAtVcq, 5, 'the stand-down is engaged at 5');
      const revBefore = m.revisionsLeft;
      throwNext = true;
      vnow += 1_000;
      await eng._maybeBid(m, Object.assign(state(19_000, null), { remainingQuantity: 2 }));
      assert.deepStrictEqual(sent, [5, 2], `the clamped count still reaches the wire, got ${sent.join(',')}`);
      assert.strictEqual(m.landedBids, 1, 'the transport failure is counted as ON THE BOARD');
      assert.strictEqual(m.revisionsLeft, revBefore - 1,
        'so it spends its revision, like every other bid the engine counts as landed');
      assert.strictEqual(m.quantityRefused, false,
        'and clears the stand-down, or the ladder freezes behind a verdict on a load that just bid');
      assert.strictEqual(m.quantityRefusedAtVcq, null, 'clearing the latched count with it');
      const cl = alertsOfKind(eng, 'vehicle_count_clamped');
      assert.strictEqual(cl.length, 1,
        `the desk must still be told the count was clamped, got ${cl.length}`);
      assert.strictEqual(cl[0].vcqSent, 2, 'with the count that went on the wire');
      assert.strictEqual(cl[0].want, 5, 'and what the desk had committed to');
      assert.strictEqual(cl[0].remaining, 2);
    } finally { Date.now = REAL_NOW; }
    ok('a clamped bid landing via the transport-failure path clears, spends and tells the desk');
  }
  {
    // ONE latch across BOTH landing paths. Two copies of the notice, each with its own latch, would
    // announce a single clamp twice the moment one bid landed by response and the next by assumption.
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 116000, 113632, 113420], { units: 5, id: 'C-both' });
    let mode = 'accept';
    eng.adapter.placeBid = async () => {
      if (mode === 'throw') throw new Error('socket hang up');
      return { accepted: true, myRank: 2, revisionsLeft: 9, latencyMs: 20 };
    };
    const REAL_NOW = Date.now; let vnow = REAL_NOW(); Date.now = () => vnow;
    try {
      await eng._maybeBid(m, Object.assign(state(20_000, 2), { remainingQuantity: 2 }));
      mode = 'throw';
      vnow += 1_000;
      await eng._maybeBid(m, Object.assign(state(19_000, 2), { remainingQuantity: 2 }));
      assert.strictEqual(alertsOfKind(eng, 'vehicle_count_clamped').length, 1,
        'the same clamp must not be announced twice because it landed on the other path');
      vnow += 1_000;
      await eng._maybeBid(m, Object.assign(state(18_000, 2), { remainingQuantity: 1 }));
    } finally { Date.now = REAL_NOW; }
    const cl = alertsOfKind(eng, 'vehicle_count_clamped');
    assert.strictEqual(cl.length, 2, `a further clamp must still alert on either path, got ${cl.length}`);
    assert.strictEqual(cl[1].remaining, 1, 'and it carries the new count');
    ok('the two landing paths share one clamp latch: no double-fire, and a lower count still alerts');
  }

  // ------------------------- 18. ONE typed read, on both sides of the platform seam
  {
    // The adapter PRODUCES remainingQuantity and the engine's plan CONSUMES it, and both have to read
    // a malformed loadTotalQuantity as UNKNOWN rather than as a real zero. The copy that runs against
    // live SuperProcure payloads is the adapter's, and it was the untested one - so this drives it
    // through getAuctionState itself and then hands the adapter's own output to the engine.
    const NOW = 1_700_000_000_000;
    const eng = mkEngine();
    const m = armMulti(eng, [119356, 113632, 113420], { units: 5, id: 'C-shared' });
    const a = new RealSuperProcureAdapter({ token: 'x' });
    a.serverNow = () => NOW;
    const seed = (q) => a.loadMeta.set('42',
      { id: '42', closesAt: NOW + 60_000, revisionLimit: 3, loadTotalQuantity: q });
    for (const junk of ['', ' ', false, true, [], {}, 'abc', NaN, Infinity, null, undefined]) {
      assert.strictEqual(numericOrNull(junk), null, `${JSON.stringify(junk)} must read as unknown`);
      seed(junk);
      const st = await a.getAuctionState('42');
      assert.strictEqual(st.ok, true, 'the read-back itself must succeed');
      assert.strictEqual(st.remainingQuantity, null,
        `getAuctionState must surface ${JSON.stringify(junk)} as unknown, never as a zero`);
      assert.strictEqual(eng._multiVehiclePlan(m, st).vcq, 5,
        `an unknown remaining must keep bid-max on ${JSON.stringify(junk)}`);
    }
    // A genuine number - and a numeric STRING, which SuperProcure does send elsewhere - survives.
    assert.strictEqual(numericOrNull(0), 0, 'a real zero is a real zero');
    assert.strictEqual(numericOrNull('2'), 2, 'and a numeric string is a number');
    seed('2');
    const st2 = await a.getAuctionState('42');
    assert.strictEqual(st2.remainingQuantity, 2, 'a numeric string is honoured end to end');
    assert.strictEqual(eng._multiVehiclePlan(m, st2).vcq, 2, 'and the engine clamps to it');
    ok('one typed read across the seam: junk is unknown, a numeric string survives, adapter included');
  }

  cleanup();
  // COMPLETION SENTINEL, not decoration. run-tests.js grades a file by its EXIT CODE alone, so a
  // file that returns early - an unhandled branch, a future edit that drops a block - exits 0 and
  // reads as a green zero-assertion run. Pinning the expected count is what makes truncation fail.
  const EXPECTED = 29;
  assert.strictEqual(pass, EXPECTED,
    `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => { cleanup(); console.error(e); process.exit(1); });
