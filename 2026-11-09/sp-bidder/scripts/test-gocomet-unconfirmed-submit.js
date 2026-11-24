'use strict';
/**
 * CW-270 regression: GoComet can persist a quote and still answer the submit PUT
 * with its close-time HTTP 422. That response is not a confirmed rejection and
 * must not be credited as a confirmed bot bid.
 *
 * Offline and deterministic: the real GoCometAdapter runs over an injected
 * fetch transport. No network, credentials, or production state are touched.
 *
 *   node scripts/test-gocomet-unconfirmed-submit.js
 */
const assert = require('node:assert/strict');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { BidEngine } = require('../src/engine/bidEngine');
const { BidLogger } = require('../src/logging/bidLogger');
const { createStore } = require('../src/store');
const { closedOutcome } = require('../src/util/closedOutcome');
const { templateFor, renderMessage } = require('../src/notify/waTemplates');
const { toNotification } = require('../src/notify/engineAlerts');

const BASE_TIME = Date.parse('2026-10-01T06:00:00Z');
const CLOSE_TIME_422 = 'Validation failed: Bid close time should be greater than 5 minutes from creation time';
const CHARGE_KEY = 'freight_charges_custom_charge_40ft';

const token = () => [
  { alg: 'ES256', typ: 'JWT' },
  { exp: BASE_TIME / 1000 + 86400, user_id: 'fixture-user', client_id: 'fixture-client', token_type: 'vendor' },
].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.fixture';

const response = (status, body) => ({
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
});

function quote(price = 100_000) {
  return {
    id: 'fixture-quote',
    enquiry_id: 'fixture-enquiry',
    status: 'draft',
    updated_at: new Date(BASE_TIME - 10_000).toISOString(),
    charges_list: {
      '11_freight_charges': {
        [CHARGE_KEY]: { price, units: 1, unit_name: 'TRUCK', currency: 'INR' },
      },
    },
    total_charges: { total: { units: 1, quote_units: 1, unit_name: 'TRUCK', total: price } },
  };
}

async function exercise({ putStatus, beforeSubmit = null, putMessage = CLOSE_TIME_422 }) {
  let now = BASE_TIME;
  let putCount = 0;
  const calls = [];
  const adapter = new GoCometAdapter({
    token: token(),
    bidEnabled: true,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    fetchImpl: async (url, init) => {
      const method = init.method;
      calls.push({ method, path: new URL(url).pathname });
      if (method === 'GET' && url.endsWith('/quotes')) return response(200, [quote()]);
      if (method === 'PUT') {
        putCount += 1;
        const submitted = JSON.parse(init.body).quote;
        return putStatus === 422
          ? response(422, { message: putMessage })
          : response(200, { data: submitted });
      }
      throw new Error(`harness: unexpected ${method} ${url}`);
    },
  });
  await adapter.login();
  let result = null;
  let thrown = null;
  try {
    result = await adapter.placeBid('fixture-enquiry', 50_000, {
      floor: 1_000,
      ...(beforeSubmit ? { beforeSubmit } : {}),
    });
  } catch (error) {
    thrown = error;
  }
  return { result, thrown, putCount, calls };
}

async function readPosition({ quoteRows, biddingData, attempt = null }) {
  let now = BASE_TIME;
  const freshBiddingData = { bid_closing_in: 60, ...biddingData };
  const adapter = new GoCometAdapter({
    token: token(),
    bidEnabled: true,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    fetchImpl: async (url, init) => {
      assert.equal(init.method, 'GET', 'reconciliation must be read-only');
      if (url.endsWith('/quotes')) return response(200, quoteRows);
      if (url.endsWith('/bidding-data')) return response(200, freshBiddingData);
      throw new Error(`harness: unexpected ${init.method} ${url}`);
    },
  });
  await adapter.login();
  return adapter.readSubmissionPosition('fixture-enquiry', attempt || {
    attemptId: 'attempt-1',
    quoteId: 'fixture-quote',
    price: 50_000,
    pricedLines: [{ key: CHARGE_KEY, price: 50_000, units: 1, currency: 'INR' }],
  });
}

const clone = (value) => JSON.parse(JSON.stringify(value));

class MemoryScheduler {
  constructor(seed = []) { this.intents = new Map(seed.map((row) => [String(row.auctionId), clone(row)])); }
  upsert(intent) {
    const id = String(intent.auctionId);
    const merged = { ...(this.intents.get(id) || {}), ...clone(intent) };
    this.intents.set(id, merged);
    return merged;
  }
  update(auctionId, patch) {
    const id = String(auctionId);
    const current = this.intents.get(id);
    if (!current) return null;
    Object.assign(current, clone(patch));
    return current;
  }
  get(auctionId) { return this.intents.get(String(auctionId)); }
  activeIntents() { return [...this.intents.values()].filter((row) => row.status !== 'closed' && row.status !== 'stopped'); }
  all() { return [...this.intents.values()]; }
  remove(auctionId) { this.intents.delete(String(auctionId)); }
  snapshot() { return clone(this.all()); }
}

function liveState(closesInMs) {
  return {
    ok: true,
    status: 'live',
    myRank: 2,
    totalBidders: null,
    standingL1Price: null,
    closesInMs,
    revisionsLeft: 3,
    revisionLimit: 3,
    closeModel: 'hard',
    measuredRttMs: 50,
    minDecrement: 100,
  };
}

function engineHarness({ position = () => ({ verified: false }), deferSubmit = false,
  firstOutcome = 'unconfirmed', seed = [], durableSubmissionTracking = true } = {}) {
  const wire = [];
  let release = null;
  let submitted = null;
  const adapter = {
    writeEnabled: true,
    capabilities: () => ({
      durableSubmissionTracking,
      standingPriceVisible: false,
      minDecrement: 100,
      allowsTieRate: false,
      revisionLimit: 3,
      closeModel: 'hard',
    }),
    ensureSession: async () => ({}),
    getAuctionState: async () => liveState(114 * 60_000),
    readSubmissionPosition: async (_id, attempt) => position(attempt),
    placeBid: async (_id, price, opts) => {
      const evidence = {
        quoteId: 'fixture-quote',
        price,
        pricedLines: [{ key: CHARGE_KEY, price, units: 1, currency: 'INR' }],
      };
      opts.beforeSubmit(evidence);
      wire.push(price);
      if (deferSubmit && wire.length === 1) {
        submitted = new Promise((resolve) => { release = resolve; });
        await submitted;
      }
      if (wire.length === 1 && firstOutcome === 'throw') {
        const error = new Error('socket hang up after dispatch');
        error.code = 'NETWORK';
        throw error;
      }
      if (wire.length === 1 && firstOutcome === 'unconfirmed') {
        return {
          accepted: false,
          submissionOutcome: 'unconfirmed',
          status: 422,
          reason: CLOSE_TIME_422,
          quoteId: evidence.quoteId,
          pricedLines: evidence.pricedLines,
          myRank: null,
          revisionsLeft: null,
          latencyMs: 30,
        };
      }
      return { accepted: true, status: 200, myRank: 1, revisionsLeft: 1, latencyMs: 30 };
    },
  };
  const scheduler = new MemoryScheduler(seed);
  const events = [];
  const engine = new BidEngine(adapter, scheduler, {
    config: { openAtMs: 2 * 60 * 60_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    live: true,
    onEvent: (event) => events.push(event),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const load = {
    id: 'GC-CW270',
    lane: { origin: 'Greater Noida', destination: 'Firozabad' },
    equipment: '32ft SXL',
    units: 1,
    companyName: 'Fixture Shipper',
    closesAt: Date.now() + 114 * 60_000,
    startsAt: Date.now() - 1_000,
    status: 'live',
    softClose: false,
  };
  const monitor = engine.arm(load, { cost: 50_000, marginsPct: [9, 5, 1], minMarginPct: 1 });
  if (monitor.timer) clearTimeout(monitor.timer);
  monitor.timer = null;
  return { adapter, scheduler, events, engine, monitor, wire, load, release: () => release && release() };
}

(async () => {
  let passed = 0;
  const failures = [];
  async function check(name, fn) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok  ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.error(`  FAIL ${name}: ${error.message}`);
    }
  }

  // catches: known ambiguous response misclassified as a definitive rejection.
  await check('known close-time 422 is an explicit unconfirmed result with raw evidence', async () => {
    const ambiguous = await exercise({ putStatus: 422 });
    assert.equal(ambiguous.putCount, 1, 'harness: the ambiguous scenario must dispatch exactly one PUT');
    assert.ifError(ambiguous.thrown);
    assert.equal(ambiguous.result.accepted, false, 'an ambiguous response is not a confirmed bot bid');
    assert.equal(
      ambiguous.result.submissionOutcome,
      'unconfirmed',
      'HTTP 422 close-time validation after dispatch must remain unconfirmed, not rejected',
    );
    assert.equal(ambiguous.result.status, 422, 'the raw HTTP status remains available for audit');
    assert.match(ambiguous.result.reason, /Bid close time should be greater than 5 minutes/i,
      'the bounded original platform reason remains available for audit');
  });

  // catches: widening the special 422 handling onto the established success path.
  await check('HTTP 200 remains accepted and is never marked unconfirmed', async () => {
    const accepted = await exercise({ putStatus: 200 });
    assert.equal(accepted.putCount, 1, 'harness: the accepted control must dispatch exactly one PUT');
    assert.ifError(accepted.thrown);
    assert.equal(accepted.result.accepted, true, 'HTTP 200 remains a confirmed accepted bid');
    assert.notEqual(accepted.result.submissionOutcome, 'unconfirmed', 'HTTP 200 must not be marked unconfirmed');
  });

  await check('an unrelated HTTP 422 remains an ordinary rejection', async () => {
    const rejected = await exercise({ putStatus: 422, putMessage: 'Validation failed: quote amount is invalid' });
    assert.equal(rejected.putCount, 1);
    assert.ifError(rejected.thrown);
    assert.equal(rejected.result.accepted, false);
    assert.notEqual(rejected.result.submissionOutcome, 'unconfirmed',
      'the exception is scoped to the observed close-time response, not every 422');
  });

  // catches: dispatch happening before its durable pending marker, or despite marker-write failure.
  await check('beforeSubmit receives safe exact wire evidence immediately before PUT', async () => {
    let evidence = null;
    const order = [];
    const run = await exercise({
      putStatus: 200,
      beforeSubmit: (attempt) => { order.push('beforeSubmit'); evidence = attempt; },
    });
    for (const call of run.calls) if (call.method === 'PUT') order.push('put');
    assert.ifError(run.thrown);
    assert.deepEqual(order, ['beforeSubmit', 'put'], 'pending marker hook must finish before the PUT starts');
    assert.equal(evidence.quoteId, 'fixture-quote');
    assert.equal(evidence.price, 50_000);
    assert.deepEqual(evidence.pricedLines, [{
      key: CHARGE_KEY, price: 50_000, units: 1, currency: 'INR',
    }], 'hook evidence must pin every priced line, including units and currency');
  });

  await check('beforeSubmit failure prevents all PUTs and is classified pre-wire', async () => {
    const markerError = Object.assign(new Error('EIO: durable marker failed'), { code: 'PERSIST_FAILED' });
    const run = await exercise({
      putStatus: 200,
      beforeSubmit: () => { throw markerError; },
    });
    assert.equal(run.putCount, 0, 'no submit may leave the process when the pending marker failed');
    assert.equal(run.thrown, markerError, 'the caller receives the marker failure');
    assert.equal(run.thrown.placed, false, 'marker failure is explicitly pre-wire');
  });

  // catches: rank-only reconciliation or matching an arbitrary quote rather than the exact wire.
  await check('read-back verifies the exact submitted quote, priced lines, and fresh budget', async () => {
    const submitted = quote(50_000);
    submitted.status = 'submitted';
    submitted.quote_rank = 2;
    const result = await readPosition({
      quoteRows: [submitted],
      biddingData: { revisions_left: 2, total_revisions: 1, vendor_rank: 2 },
    });
    assert.equal(result.verified, true);
    assert.equal(result.quoteId, 'fixture-quote');
    assert.equal(result.price, 50_000);
    assert.equal(result.revisionsLeft, 2);
    assert.equal(result.rank, 2);
    assert.equal(result.biddingOpen, true, 'fresh bidding-data says the enquiry is still open');
    assert.equal(result.closesInMs, 60_000, 'fresh portal countdown is returned with the account position');
    assert.ok(Number.isFinite(result.verifiedAt) && result.verifiedAt >= BASE_TIME,
      'verification carries the adapter clock timestamp after its fresh reads');
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'writer'), false,
      'shared-account read-back must not attribute the writer');
  });

  await check('read-back refuses wrong id, state, price, units, currency, ambiguity, and stale budget', async () => {
    const exact = quote(50_000);
    exact.status = 'submitted';
    const live = { revisions_left: 2, total_revisions: 1, vendor_rank: 1 };
    const variants = [];
    const wrongId = JSON.parse(JSON.stringify(exact)); wrongId.id = 'other-quote'; variants.push(['quote id', [wrongId], live]);
    const draft = JSON.parse(JSON.stringify(exact)); draft.status = 'draft'; variants.push(['quote state', [draft], live]);
    const wrongPrice = JSON.parse(JSON.stringify(exact)); wrongPrice.charges_list['11_freight_charges'][CHARGE_KEY].price = 49_900;
    variants.push(['price', [wrongPrice], live]);
    const wrongUnits = JSON.parse(JSON.stringify(exact)); wrongUnits.charges_list['11_freight_charges'][CHARGE_KEY].units = 2;
    variants.push(['units', [wrongUnits], live]);
    const wrongCurrency = JSON.parse(JSON.stringify(exact)); wrongCurrency.charges_list['11_freight_charges'][CHARGE_KEY].currency = 'USD';
    variants.push(['currency', [wrongCurrency], live]);
    variants.push(['duplicate quote id', [exact, JSON.parse(JSON.stringify(exact))], live]);
    variants.push(['missing revision budget', [exact], { total_revisions: 1, vendor_rank: 1 }]);
    for (const [name, rows, state] of variants) {
      assert.deepEqual(await readPosition({ quoteRows: rows, biddingData: state }), { verified: false },
        `${name} mismatch must remain unverified`);
    }
  });

  await check('read-back requires every priced line on a multi-type quote', async () => {
    const multi = quote(50_000);
    multi.status = 'selected';
    const secondKey = 'freight_charges_custom_charge_32ft';
    multi.charges_list['11_freight_charges'][secondKey] = {
      price: 55_000, units: 2, unit_name: 'TRUCK', currency: 'INR',
    };
    const attempt = {
      attemptId: 'attempt-multi', quoteId: 'fixture-quote', price: 50_000,
      pricedLines: [
        { key: CHARGE_KEY, price: 50_000, units: 1, currency: 'INR' },
        { key: secondKey, price: 55_000, units: 2, currency: 'INR' },
      ],
    };
    const live = { revisions_left: 1, total_revisions: 2, vendor_rank: 1 };
    const verified = await readPosition({ quoteRows: [multi], biddingData: live, attempt });
    assert.equal(verified.verified, true, 'all exact truck-type lines verify the account position');
    const changed = JSON.parse(JSON.stringify(multi));
    changed.charges_list['11_freight_charges'][secondKey].price = 54_999;
    assert.deepEqual(await readPosition({ quoteRows: [changed], biddingData: live, attempt }), { verified: false },
      'one mismatched truck-type line invalidates the whole observation');
  });

  await check('read-back carries a fresh closed verdict even when revisions remain', async () => {
    const submitted = quote(50_000);
    submitted.status = 'submitted';
    const result = await readPosition({
      quoteRows: [submitted],
      biddingData: { revisions_left: 2, total_revisions: 1, vendor_rank: 1, bid_closing_in: null },
    });
    assert.equal(result.verified, true, 'the exact account quote remains observable after close');
    assert.equal(result.biddingOpen, false, 'explicit null countdown is the portal closed verdict');
    assert.equal(result.closesInMs, 0, 'closed evidence carries zero remaining time');
  });

  await check('submission checking stays out of recipient notifications', async () => {
    assert.equal(toNotification({ type: 'alert', kind: 'submission_unconfirmed', auctionId: 'GC-QUIET',
      detail: 'We are checking the account quote before another bid' }), null);
  });

  await check('close checks the pending quote before emitting the result without creating bid credit', async () => {
    let reads = 0;
    const h = engineHarness({ position: attempt => {
      reads++;
      return { verified: true, quoteId: attempt.quoteId, price: attempt.price,
        biddingOpen: false, closesInMs: 0, revisionsLeft: 2, rank: 1, verifiedAt: Date.now() };
    } });
    try {
      await h.engine._maybeBid(h.monitor, liveState(114 * 60_000));
      const closing = h.engine._finalize(h.monitor, { ...liveState(0), myRank: 1 });
      assert.equal(h.events.filter(e => e.type === 'auction_result').length, 0,
        'the receipt waits for the quiet confirmation step');
      await closing;
      assert.equal(reads, 1, 'a pending quote receives a fresh read at close');
      const result = h.events.find(e => e.type === 'auction_result');
      assert.equal(result.gcUnconfirmedSubmissions[0].accountQuoteVerified.verified, true);
      assert.equal(result.landedBids, 0, 'a shared account quote is never turned into bot credit');
      assert.equal(h.wire.length, 1, 'confirmation does not submit again');
      assert.equal(h.events.filter(e => e.kind === 'never_bid_before_close').length, 0,
        'an ambiguous submission does not produce a second false no-bid alarm');
    } finally { h.engine.kill('test complete'); }
  });

  await check('a hung close confirmation times out and a late read cannot change the closed record', async () => {
    let release;
    const h = engineHarness({ position: () => new Promise(resolve => { release = resolve; }) });
    try {
      await h.engine._maybeBid(h.monitor, liveState(114 * 60_000));
      await h.engine._finalize(h.monitor, liveState(0));
      assert.equal(h.events.filter(e => e.type === 'auction_result').length, 1);
      assert.equal(typeof release, 'function', 'the bounded read was actually attempted');
      release({ verified: true, price: h.wire[0], rank: 1, revisionsLeft: 2, verifiedAt: Date.now() });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.scheduler.get(h.monitor.auctionId).gcUnconfirmedSubmissions[0].accountQuoteVerified, undefined);
      assert.equal(h.events.filter(e => e.type === 'auction_result').length, 1);
      assert.equal(h.wire.length, 1);
    } finally { h.engine.kill('test complete'); }
  });

  await check('Stop during confirmation suppresses the result and unrelated loads keep bidding', async () => {
    const h = engineHarness();
    const other = engineHarness({ firstOutcome: 'accepted' });
    try {
      await h.engine._maybeBid(h.monitor, liveState(114 * 60_000));
      const closing = h.engine._finalize(h.monitor, liveState(0));
      await other.engine._maybeBid(other.monitor, liveState(114 * 60_000));
      assert.equal(other.wire.length, 1, 'another engine runs while this confirmation waits');
      h.engine.kill('operator Stop');
      await closing;
      assert.equal(h.events.filter(e => e.type === 'auction_result').length, 0);
    } finally { h.engine.kill('test complete'); other.engine.kill('test complete'); }
  });

  await check('engine persists one unconfirmed attempt without bot or rejection credit', async () => {
    const h = engineHarness();
    try {
      await h.engine._maybeBid(h.monitor, liveState(114 * 60_000));
      assert.equal(h.wire.length, 1, 'one and only one submit reached the adapter');
      assert.equal(h.monitor.landedBids, 0, 'unconfirmed submit is not credited as a bot bid');
      assert.equal(Number(h.monitor.refusedAttempts) || 0, 0, 'unconfirmed submit is not counted as rejected');
      assert.equal(h.monitor.lastBidPrice, null, 'bot-only lastBidPrice stays empty');
      const row = h.scheduler.get(h.monitor.auctionId);
      assert.ok(row.pendingGcSubmission && row.pendingGcSubmission.attemptId,
        'the unresolved attempt remains durable as a retry hold');
      assert.equal(row.pendingGcSubmission.outcome, 'unconfirmed');
      assert.equal(row.gcUnconfirmedSubmissions.length, 1);
      assert.equal(row.gcUnconfirmedSubmissions[0].attemptId, row.pendingGcSubmission.attemptId,
        'pending hold and audit row share one stable attempt id');
      assert.equal(h.events.filter((event) => event.type === 'bid_unconfirmed').length, 1,
        'one distinct unconfirmed event is emitted');
      assert.equal(h.events.filter((event) => event.type === 'bid_placed').length, 0,
        'no bid_placed event leaks bot credit');
      assert.equal(h.events.filter((event) => event.type === 'bid_rejected').length, 0,
        'no bid_rejected event inflates portal refusal counts');
    } finally { h.engine.kill('test complete'); }
  });

  await check('a transport throw after the durable pre-wire marker is also unconfirmed', async () => {
    const h = engineHarness({ firstOutcome: 'throw' });
    try {
      await h.engine._maybeBid(h.monitor, liveState(114 * 60_000));
      assert.equal(h.wire.length, 1, 'harness: one PUT-equivalent dispatch occurred before the throw');
      assert.equal(h.monitor.landedBids, 0, 'dispatched throw is not blindly credited as landed on GoComet');
      assert.equal(Number(h.monitor.refusedAttempts) || 0, 0, 'dispatched throw is not called rejected');
      const row = h.scheduler.get(h.monitor.auctionId);
      assert.equal(row.gcUnconfirmedSubmissions.length, 1);
      assert.equal(row.pendingGcSubmission.outcome, 'unconfirmed');
      assert.equal(h.events.filter((event) => event.type === 'bid_unconfirmed').length, 1);
      assert.equal(h.events.filter((event) => event.type === 'bid_placed').length, 0);
    } finally { h.engine.kill('test complete'); }
  });

  await check('durable-marker failure blocks dispatch and holds the monitor', async () => {
    const h = engineHarness();
    const update = h.scheduler.update.bind(h.scheduler);
    h.scheduler.update = (id, patch) => {
      if (patch && patch.pendingGcSubmission) throw new Error('EIO: intent disk full');
      return update(id, patch);
    };
    try {
      await h.engine._maybeBid(h.monitor, liveState(114 * 60_000));
      assert.equal(h.wire.length, 0, 'no write leaves without the durable marker');
      assert.equal(h.monitor._gcPersistenceBlocked, true, 'automatic bidding remains held after marker failure');
      assert.equal(h.monitor.landedBids, 0);
      assert.equal(h.events.filter((event) => event.type === 'bid_placed').length, 0);
    } finally { h.engine.kill('test complete'); }
  });

  await check('unverified account state holds; verified state permits only a strictly lower bid', async () => {
    let accountPosition = { verified: false };
    const h = engineHarness({ position: () => accountPosition });
    try {
      await h.engine._maybeBid(h.monitor, liveState(114 * 60_000));
      const unresolvedPrice = h.wire[0];
      h.monitor._gcCheckedAt = 0;
      await h.engine._maybeBid(h.monitor, liveState(60 * 60_000));
      assert.deepEqual(h.wire, [unresolvedPrice], 'no fresh account evidence means no second PUT');

      accountPosition = {
        verified: true,
        biddingOpen: true,
        closesInMs: 60_000,
        quoteId: 'fixture-quote',
        price: unresolvedPrice,
        revisionsLeft: 2,
        rank: 2,
        verifiedAt: Date.now(),
      };
      h.monitor._gcCheckedAt = 0;
      await h.engine._maybeBid(h.monitor, liveState(60 * 60_000));
      assert.equal(h.wire.length, 2, 'fresh verified position restores the normal lower-bid path');
      assert.ok(h.wire[1] < unresolvedPrice,
        `the next PUT must be strictly lower than unresolved ${unresolvedPrice}; got ${h.wire[1]}`);
      assert.equal(h.wire.filter((price) => price === unresolvedPrice).length, 1,
        'the unresolved same-price attempt is never repeated');
      assert.equal(h.events.filter((event) => event.kind === 'submission_unconfirmed').length, 1,
        'the actionable desk notice is emitted once even when reconciliation runs again');
    } finally { h.engine.kill('test complete'); }
  });

  await check('restart/re-arm preserves the unresolved hold and does not redispatch', async () => {
    const first = engineHarness();
    await first.engine._maybeBid(first.monitor, liveState(114 * 60_000));
    const attemptId = first.scheduler.get(first.monitor.auctionId).pendingGcSubmission.attemptId;
    const seed = first.scheduler.snapshot();
    first.engine.kill('simulated restart');

    const restarted = engineHarness({ seed, position: () => ({ verified: false }) });
    try {
      if (restarted.monitor.timer) clearTimeout(restarted.monitor.timer);
      const row = restarted.scheduler.get(restarted.monitor.auctionId);
      assert.equal(row.pendingGcSubmission.attemptId, attemptId, 're-arm carries the original pending attempt id');
      assert.equal(row.gcUnconfirmedSubmissions.length, 1, 're-arm carries the audit row without duplication');
      restarted.monitor._gcCheckedAt = 0;
      await restarted.engine._maybeBid(restarted.monitor, liveState(60 * 60_000));
      assert.equal(restarted.wire.length, 0, 'restart with unresolved account state sends no duplicate PUT');
    } finally { restarted.engine.kill('test complete'); }
  });

  await check('operator Stop wins over an in-flight unconfirmed response', async () => {
    const h = engineHarness({ deferSubmit: true });
    const inFlight = h.engine._maybeBid(h.monitor, liveState(114 * 60_000));
    for (let i = 0; i < 20 && h.wire.length === 0; i += 1) await Promise.resolve();
    assert.equal(h.wire.length, 1, 'harness: submit reached the wire before Stop');
    // The operator path durably marks the intent, then retires its in-memory monitor.
    h.scheduler.update(h.monitor.auctionId, { status: 'stopped' });
    h.engine.stop(h.monitor.auctionId);
    h.release();
    await inFlight;
    assert.equal(h.scheduler.get(h.monitor.auctionId).status, 'stopped', 'late response cannot reactivate a stopped intent');
    assert.equal(h.engine.monitors.has(h.monitor.auctionId), false, 'late response cannot recreate the stopped monitor');
    assert.equal(h.events.filter((event) => event.type === 'bid_placed').length, 0, 'late ambiguous response earns no bid credit');
  });

  await check('late accepted response after re-price clears only its matching pending attempt everywhere', async () => {
    const h = engineHarness({ deferSubmit: true, firstOutcome: 'accepted' });
    const old = h.monitor;
    const inFlight = h.engine._maybeBid(old, liveState(114 * 60_000));
    for (let i = 0; i < 20 && h.wire.length === 0; i += 1) await Promise.resolve();
    assert.equal(h.wire.length, 1, 'harness: old monitor dispatched before re-price');
    const attemptId = h.scheduler.get(old.auctionId).pendingGcSubmission.attemptId;
    h.engine.stop(old.auctionId);
    const successor = h.engine.arm(h.load, { cost: 51_000, marginsPct: [9, 5, 1], minMarginPct: 1 });
    if (successor.timer) clearTimeout(successor.timer);
    successor.timer = null;
    assert.equal(successor.pendingGcSubmission.attemptId, attemptId, 'harness: successor inherited the in-flight hold');
    h.release();
    await inFlight;
    assert.equal(h.scheduler.get(old.auctionId).pendingGcSubmission, null, 'accepted bid clears the durable matching hold');
    assert.equal(old.pendingGcSubmission, null, 'retired monitor clears its matching hold');
    assert.equal(successor.pendingGcSubmission, null, 'successor monitor clears the same matching hold');
    assert.equal(h.events.filter((event) => event.type === 'bid_placed').length, 1, 'accepted response is booked exactly once');
    assert.equal(h.events.filter((event) => event.type === 'bid_unconfirmed').length, 0,
      'late success never creates a phantom unconfirmed audit row');
    h.engine.kill('test complete');
  });

  await check('fresh live rank outranks an older reconciliation rank', async () => {
    let position = { verified: false };
    const h = engineHarness({ position: () => position });
    try {
      await h.engine._maybeBid(h.monitor, liveState(114 * 60_000));
      position = { verified: true, quoteId: 'fixture-quote', price: h.wire[0], revisionsLeft: 2,
        rank: 1, verifiedAt: Date.now(), biddingOpen: true, closesInMs: 60_000 };
      h.monitor._gcCheckedAt = 0;
      let rankSeen = null;
      const decide = h.engine._decide;
      h.engine._decide = (_monitor, state) => { rankSeen = state.myRank; return null; };
      await h.engine._maybeBid(h.monitor, { ...liveState(60 * 60_000), myRank: 2 });
      h.engine._decide = decide;
      assert.equal(rankSeen, 2, 'ordinary decision uses the fresher live tick rank, not cached reconciliation rank 1');
    } finally { h.engine.kill('test complete'); }
  });

  await check('fresh closed reconciliation prevents a second PUT', async () => {
    let position = { verified: false };
    const h = engineHarness({ position: () => position });
    try {
      await h.engine._maybeBid(h.monitor, liveState(114 * 60_000));
      const first = h.wire[0];
      position = { verified: true, quoteId: 'fixture-quote', price: first, revisionsLeft: 2,
        rank: 2, verifiedAt: Date.now(), biddingOpen: false, closesInMs: 0 };
      h.monitor._gcCheckedAt = 0;
      await h.engine._maybeBid(h.monitor, { ...liveState(60 * 60_000), myRank: 2 });
      assert.deepEqual(h.wire, [first], 'fresh portal closure blocks a lower follow-up even with revisions left');
    } finally { h.engine.kill('test complete'); }
  });

  await check('verified account evidence persists through intent, monitor, ledger and re-arm', async () => {
    let position = { verified: false };
    const h = engineHarness({ position: () => position });
    try {
      await h.engine._maybeBid(h.monitor, liveState(114 * 60_000));
      const first = h.wire[0];
      position = { verified: true, quoteId: 'fixture-quote', price: first, revisionsLeft: 2,
        rank: 2, verifiedAt: Date.now(), biddingOpen: true, closesInMs: 60_000 };
      h.monitor._gcCheckedAt = 0;
      const decide = h.engine._decide;
      h.engine._decide = () => null;
      await h.engine._maybeBid(h.monitor, { ...liveState(60 * 60_000), myRank: 2 });
      h.engine._decide = decide;
      const intent = h.scheduler.get(h.monitor.auctionId);
      assert.equal(intent.gcUnconfirmedSubmissions[0].accountQuoteVerified.rank, 2,
        'verified account evidence is merged into the durable intent');
      assert.equal(h.monitor.gcUnconfirmedSubmissions[0].accountQuoteVerified.rank, 2,
        'the live monitor carries the same merged evidence');

      const store = createStore({ backend: 'memory' });
      const logger = new BidLogger({ store, log: () => {} });
      for (const event of h.events) await logger.handle(event);
      const before = await store.getDoc('closedBids', h.monitor.auctionId);
      assert.equal(before.gcUnconfirmedSubmissions[0].accountQuoteVerified.rank, 2,
        'the ledger carries the verified account evidence');

      const seed = h.scheduler.snapshot();
      h.engine.kill('simulated restart');
      const restarted = engineHarness({ seed, position: () => ({ verified: false }) });
      try {
        assert.equal(restarted.monitor.gcUnconfirmedSubmissions[0].accountQuoteVerified.rank, 2,
          'restart/re-arm does not erase verified evidence from the monitor');
        const armed = restarted.events.find((event) => event.type === 'armed');
        await logger.handle(armed);
        const after = await store.getDoc('closedBids', restarted.monitor.auctionId);
        assert.equal(after.gcUnconfirmedSubmissions[0].accountQuoteVerified.rank, 2,
          'restart/re-price does not overwrite newer ledger evidence with an older row');
      } finally { restarted.engine.kill('test complete'); }
    } finally { if (!h.engine.killed) h.engine.kill('test complete'); }
  });

  await check('confirmed bids retain the unchanged normal outcome and receipt', async () => {
    const attempts = [{ attemptId: 'old-unconfirmed', price: 54_500, outcome: 'unconfirmed' }];
    assert.equal(closedOutcome({ ourBids: [{ price: 52_500 }], won: true, finalRank: 1,
      gcUnconfirmedSubmissions: attempts }), 'won', 'a later confirmed bid restores normal won semantics');
    assert.equal(closedOutcome({ ourBids: [{ price: 52_500 }], won: false, finalRank: 2,
      gcUnconfirmedSubmissions: attempts }), 'lost', 'a later confirmed bid restores normal lost semantics');
    for (const [kind, finalRank] of [['won', 1], ['lost', 2]]) {
      const data = { platformKey: 'gocomet', shipperName: 'Fixture Shipper', oaNo: 'GC-MIXED',
        vehicleType: '32ft SXL', lane: { origin: 'Greater Noida', destination: 'Firozabad' },
        landedBids: 1, unconfirmedCount: 1, finalRank, won: kind === 'won', resultFacts: true,
        attemptsAllowed: 3, lastBidPrice: 52_500, gcUnconfirmedSubmissions: attempts };
      const selected = templateFor(kind, data);
      assert.equal(selected, kind, `mixed history keeps the normal ${kind} receipt`);
      const text = renderMessage(selected, data);
      assert.equal(text, renderMessage(kind, { ...data, unconfirmedCount: 0 }),
        `${kind} receipt stays unchanged despite internal uncertainty history`);
      assert.doesNotMatch(text, /^\*SUBMISSION UNCONFIRMED/m,
        `${kind} receipt is not replaced by the zero-confirmed-bid uncertainty headline`);
    }
  });

  await check('durable pre-submit persistence reserves exactly 100ms in both timing gates', async () => {
    const tracked = engineHarness({ durableSubmissionTracking: true });
    const plain = engineHarness({ durableSubmissionTracking: false });
    try {
      assert.equal(tracked.engine._writeRunwayMs() - plain.engine._writeRunwayMs(), 100,
        'write runway includes the measured durable persistence allowance');
      tracked.monitor.provisionalClose = true;
      plain.monitor.provisionalClose = true;
      const trackedWalk = tracked.engine.walkParams(tracked.monitor, { clockErrorMs: 0 });
      const plainWalk = plain.engine.walkParams(plain.monitor, { clockErrorMs: 0 });
      assert.equal(trackedWalk.landMs - plainWalk.landMs, 100,
        'walk landing budget includes the same persistence allowance');
    } finally {
      tracked.engine.kill('test complete');
      plain.engine.kill('test complete');
    }
  });

  await check('bid logger stores one idempotent unconfirmed audit row outside bid/rejection counts', async () => {
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store, log: () => {} });
    const auctionId = 'GC-CW270-LOG';
    await logger.handle({
      type: 'armed', auctionId, platformKey: 'gocomet', account: 'gocomet',
      lane: { origin: 'Greater Noida', destination: 'Firozabad' }, equipment: '32ft SXL', units: 1,
      companyName: 'Fixture Shipper', cost: 50_000, floor: 50_500, ladder: [54_500, 52_500, 50_500], ts: BASE_TIME,
    });
    const submission = {
      attemptId: 'attempt-stable-1', quoteId: 'fixture-quote', price: 54_500,
      pricedLines: [{ key: CHARGE_KEY, price: 54_500, units: 1, currency: 'INR' }],
      status: 422, reason: CLOSE_TIME_422, outcome: 'unconfirmed', decidedAt: BASE_TIME + 10,
    };
    await logger.handle({ type: 'bid_unconfirmed', auctionId, submission });
    await logger.handle({ type: 'bid_unconfirmed', auctionId, submission: {
      ...submission,
      accountQuoteVerified: { verified: true, quoteId: 'fixture-quote', price: 54_500,
        revisionsLeft: 2, rank: 1, verifiedAt: BASE_TIME + 5_000 },
    } });
    const record = await store.getDoc('closedBids', auctionId);
    assert.equal(record.ourBids.length, 0, 'unconfirmed account quote is not appended to bot bids');
    assert.equal((record.rejectedBids || []).length, 0, 'unconfirmed response is not appended to rejected bids');
    assert.equal(record.gcUnconfirmedSubmissions.length, 1, 'replayed/reconciled event updates one stable attempt');
    assert.equal(record.gcUnconfirmedSubmissions[0].attemptId, 'attempt-stable-1');
    assert.equal(record.gcUnconfirmedSubmissions[0].accountQuoteVerified.rank, 1,
      'account-level portal evidence is preserved separately from authorship');
  });

  await check('closed outcome and WhatsApp receipt keep portal rank separate from bot credit', async () => {
    const data = {
      platformKey: 'gocomet',
      shipperName: 'Fixture Shipper',
      oaNo: 'GC-CW270-RESULT',
      vehicleType: '32ft SXL',
      lane: { origin: 'Greater Noida', destination: 'Firozabad' },
      landedBids: 0,
      unconfirmedCount: 1,
      won: true,
      finalRank: 1,
      awardConfirmed: true,
      resultFacts: true,
      attemptsAllowed: 3,
      gcUnconfirmedSubmissions: [{
        attemptId: 'attempt-stable-1', price: 54_500, status: 422, reason: CLOSE_TIME_422,
        accountQuoteVerified: { verified: true, price: 54_500, quoteId: 'fixture-quote', rank: 1, revisionsLeft: 2 },
      }],
      accountQuote: { verified: true, price: 54_500, quoteId: 'fixture-quote', rank: 1, revisionsLeft: 2 },
    };
    assert.equal(closedOutcome({ ourBids: [], won: true, finalRank: 1,
      gcUnconfirmedSubmissions: data.gcUnconfirmedSubmissions }), 'closed_unknown',
    'a portal outcome with uncertain bot participation is not no_bid or a credited win');
    const selected = templateFor('won', data);
    const text = renderMessage(selected, data);
    assert.equal(typeof text, 'string', 'the unconfirmed result selects a real receipt template');
    assert.equal(text, '*OA No* - GC-CW270-RESULT\nBid submitted. Please check the position on GoComet.');
    assert.doesNotMatch(text, /unconfirmed|automatic|checking|confirmed Bid Command|Portal rank/i,
      'the fallback contains no internal accounting or diagnostic narrative');
    assert.doesNotMatch(text, /\bWON\b|WE WON/i, 'receipt does not credit a win to Bid Command');
    assert.doesNotMatch(text, /refused by the portal/i, 'receipt does not call the ambiguous response a rejection');
    assert.doesNotMatch(text, /Our Bid|Won Rate|Margin/i, 'receipt prints no bot rate or bot margin');
  });

  if (failures.length) {
    console.error(`FAIL - ${failures.length} of ${passed + failures.length} checks failed`);
    process.exit(1);
  }
  console.log(`${passed}/${passed} checks passed`);
})().catch((error) => {
  console.error(`FAIL - ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
