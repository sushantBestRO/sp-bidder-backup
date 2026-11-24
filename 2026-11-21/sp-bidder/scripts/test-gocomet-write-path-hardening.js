'use strict';
/**
 * GoComet WRITE PATH - the three money-path defects found by the 2026-08-11 bug hunt, each pinned
 * by the shape that actually failed. All offline: mocked transport, no token, no network.
 *
 *   PART 1  LOST UPDATE. placeBid was a read-modify-write of the WHOLE quote with no version
 *           check, on a document BRL's `autopilot` process writes under the same vendor identity.
 *           A revision landing between our read and our submit was reverted to the values we read,
 *           200 on both writes: 92,000 replaced by our 98,000 (our own price RAISED on a reverse
 *           auction) and a sibling detention line we never priced dragged 7,500 -> 5,000.
 *   PART 2  REJECT-PATH EGRESS. `reason`, `raw` and the warn line carried the ENTIRE raw submit
 *           response, which lands in closedBids.json, the un-backfillable bids-*.jsonl and
 *           pm2-err.log. The read path already closed this class with an allowlist projection.
 *   PART 3  THE UNENFORCED CEILING. `ceiling_rate` was fetched, cached, and read by nothing, so
 *           the engine's ladder cap saw no ceiling and the adapter had no ceiling belt - a bid of
 *           120,000 went on the wire against a stated ceiling of 40,000.
 *
 *   node scripts/test-gocomet-write-path-hardening.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent file), not app state
const path = require('path');
const assert = require('assert');
const { GoCometAdapter, projectSubmitError, SUBMIT_ERROR_MAX_CHARS } = require('../src/platform/gocometAdapter');
const { plausibleCeiling } = require('../src/engine/pricing');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

// ---- test doubles (the house pattern from test-gocomet-adapter.js) ----------------------------
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const validToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' })}.sig`;
const resp = (status, body) => ({
  status,
  headers: { get: () => null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const noSleep = async () => {};
const clone = (o) => JSON.parse(JSON.stringify(o));

/** A logger that records every line so a test can assert on what would reach pm2-err.log. */
function recordingLog() {
  const lines = [];
  const at = (level) => (msg, payload) => lines.push({ level, msg, payload });
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'),
    text: () => JSON.stringify(lines) };
}

const FREIGHT = 'freight_charges_custom_charge_40ft';
const DETENTION = 'detention_charges_custom_charge_1';
const freightPrice = (q) => q.charges_list['11_freight_charges'][FREIGHT].price;
const detentionPrice = (q) => q.charges_list['11_freight_charges'][DETENTION].price;

/** The captured quote shape: one freight group, one priced freight line, one sibling we never price. */
function quoteDoc({ id = 'Q1', price = 100000, detention = 5000, updatedAt = '2026-08-11T09:00:00Z', remarks = '' } = {}) {
  return {
    id,
    updated_at: updatedAt,
    remarks,
    charges_list: { '11_freight_charges': {
      display_name: 'Freight',
      [FREIGHT]: { units: 2, unit_name: "TRUCK TONS 25 40'X8'X8.8') - (LXWXH 40FT", price },
      [DETENTION]: { units: 2, unit_name: 'TRUCK', price: detention },
    } },
    total_charges: { total: { units: 2.0, quote_units: 2.0, unit_name: 'TRUCK', total: 210000.0 } },
  };
}

(async () => {
  // =============================================================================================
  // PART 1 - LOST UPDATE
  // =============================================================================================

  // ---- 1a. a concurrent revision committed at the read/write seam is REFUSED, never reverted ----
  // GATED, not slept: flow A (our bid) is held inside the fake transport at the moment it has read
  // the quote, flow B (autopilot) commits its revision, then A is released and goes on to submit.
  // The interleaving is forced, so this is deterministic rather than a race the suite might miss.
  {
    const server = { quote: quoteDoc(), puts: 0 };
    let aReadOnce; const aHasRead = new Promise((r) => { aReadOnce = r; });
    let bCommitted; const bDone = new Promise((r) => { bCommitted = r; });

    const flowB = (async () => {
      await aHasRead;
      // autopilot revises the freight price DOWN and touches the sibling line, as it does today.
      server.quote.charges_list['11_freight_charges'][FREIGHT].price = 92000;
      server.quote.charges_list['11_freight_charges'][DETENTION].price = 7500;
      server.quote.updated_at = '2026-08-11T09:00:02Z';
      bCommitted();
    })();

    let gets = 0;
    const fetchImpl = async (url, init) => {
      if (init.method === 'GET' && url.includes('/quotes')) {
        gets += 1;
        const snapshot = clone(server.quote);
        if (gets === 1) { aReadOnce(); await bDone; }  // hold A between its read and its re-read
        return resp(200, [snapshot]);
      }
      if (init.method === 'PUT' && url.includes('/quotes/Q1/submit')) {
        server.quote = JSON.parse(init.body).quote; server.puts += 1;
        return resp(200, { data: { quote_rank: 2, can_submit_quote: true } });
      }
      return resp(404, {});
    };

    const log = recordingLog();
    const a = new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl, sleep: noSleep, log });
    await a.login();
    let err = null;
    try { await a.placeBid('ENQ-1', 98000, { floor: 50000 }); } catch (e) { err = e; }
    await flowB;

    ok(err && err.code === 'QUOTE_CHANGED', `a revision landing at the read/write seam is refused (got ${err && err.code})`);
    ok(server.puts === 0, 'the refused bid never PUTs, so no revision is spent on a write we cannot reason about');
    ok(freightPrice(server.quote) === 92000, `the other writer's price survives (got ${freightPrice(server.quote)}, not our 98000)`);
    ok(detentionPrice(server.quote) === 7500, `the sibling line we never priced survives (got ${detentionPrice(server.quote)})`);
    ok(log.lines.some((l) => l.level === 'error' && /moved under us/.test(l.msg)),
      'the refusal is surfaced at error level so a human can see it happened');
  }

  // ---- 1b. CONTROL: an unchanged quote still bids, and the submit is unchanged in shape ----
  {
    const server = { quote: quoteDoc(), puts: 0 };
    let gets = 0;
    const { fetchImpl, puts } = (() => {
      const puts = [];
      return { puts, fetchImpl: async (url, init) => {
        if (init.method === 'GET' && url.includes('/quotes')) { gets += 1; return resp(200, [clone(server.quote)]); }
        if (init.method === 'PUT') { puts.push(JSON.parse(init.body)); server.puts += 1; return resp(200, { data: { quote_rank: 1, can_submit_quote: true } }); }
        return resp(404, {});
      } };
    })();
    const a = new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl, sleep: noSleep });
    await a.login();
    const r = await a.placeBid('ENQ-1', 98000, { floor: 50000 });
    ok(r.accepted === true, 'an untouched quote still bids');
    ok(gets === 2, `the bid reads the quote and confirms it before submitting (gets=${gets})`);
    ok(puts.length === 1 && puts[0].quote.charges_list['11_freight_charges'][FREIGHT].price === 98000,
      'exactly one submit, carrying our amount on the freight line');
    ok(puts[0].quote.charges_list['11_freight_charges'][DETENTION].price === 5000,
      'the sibling line rides at the value the server holds, not one we invented');
  }

  // ---- 1c. the submit is rebased onto the CONFIRMING read, not the first one ----
  // The change is deliberately OUTSIDE the fingerprint (remarks, not a charge line): the comparison
  // is scoped to the money-bearing state so an unrelated server-side field cannot refuse a live
  // bid, and this proves the submitted bytes still come from the freshest read.
  {
    const server = { quote: quoteDoc({ remarks: 'stale' }) };
    let gets = 0; const puts = [];
    const fetchImpl = async (url, init) => {
      if (init.method === 'GET' && url.includes('/quotes')) {
        gets += 1;
        if (gets === 1) return resp(200, [clone(server.quote)]);
        return resp(200, [clone(Object.assign({}, server.quote, { remarks: 'fresh' }))]);
      }
      if (init.method === 'PUT') { puts.push(JSON.parse(init.body)); return resp(200, { data: { quote_rank: 1 } }); }
      return resp(404, {});
    };
    const a = new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl, sleep: noSleep });
    await a.login();
    const r = await a.placeBid('ENQ-1', 98000, { floor: 50000 });
    ok(r.accepted === true, 'a change outside the money-bearing state does not refuse the bid');
    ok(puts.length === 1 && puts[0].quote.remarks === 'fresh',
      `the submitted document is the confirming read, not the first one (got remarks=${puts[0] && puts[0].quote.remarks})`);
  }

  // ---- 1d. the confirming read cannot be skipped by a transport failure ----
  {
    let gets = 0; const puts = [];
    const fetchImpl = async (url, init) => {
      if (init.method === 'GET' && url.includes('/quotes')) {
        gets += 1;
        if (gets === 1) return resp(200, [quoteDoc()]);
        return { status: 0, headers: { get: () => null }, text: async () => null };
      }
      if (init.method === 'PUT') { puts.push(JSON.parse(init.body)); return resp(200, { data: {} }); }
      return resp(404, {});
    };
    const a = new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl, sleep: noSleep });
    await a.login();
    let err = null;
    try { await a.placeBid('ENQ-1', 98000, { floor: 50000 }); } catch (e) { err = e; }
    ok(err && err.code === 'NETWORK', `an unconfirmable quote fails closed (got ${err && err.code})`);
    ok(puts.length === 0, 'nothing is submitted against a document we could not confirm');
  }

  // =============================================================================================
  // PART 2 - REJECT-PATH EGRESS
  // =============================================================================================

  // The sentinel stands in for the class the read-path allowlist exists to keep out: GoComet serves
  // a third party's credential hash on the enquiry endpoint, and no capture bounds what it puts in
  // an ERROR body.
  const SENTINEL = 'SENTINEL-PWDIGEST-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  function rejectingAdapter(body) {
    const log = recordingLog();
    const fetchImpl = async (url, init) => {
      if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quoteDoc()]);
      if (init.method === 'PUT') return resp(422, body);
      return resp(404, {});
    };
    return { log, a: new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl, sleep: noSleep, log }) };
  }

  // ---- 2a. a JSON rejection with NO `.message` key: the whole body used to become `reason` ----
  {
    const { log, a } = rejectingAdapter({
      errors: ['quote rejected'], enquiry: '260804UYVU',
      created_by: { id: 'u-0001', name: 'THIRD PARTY STAFF', email: 'x@example.invalid', password_digest: SENTINEL },
    });
    await a.login();
    const r = await a.placeBid('ENQ-1', 98000, { floor: 50000 });
    ok(r.accepted === false, 'the submit is still reported as rejected');
    ok(!String(r.reason).includes(SENTINEL), `reason carries no unallowlisted field (got ${JSON.stringify(r.reason)})`);
    ok(String(r.reason).includes('quote rejected'), 'the allowlisted "why" survives - the forensic trace is not the price of the fix');
    ok(!JSON.stringify(r.raw || '').includes(SENTINEL), 'raw carries no unallowlisted field either');
    ok(!log.text().includes(SENTINEL), 'and nothing reaches the log stream (pm2-err.log) verbatim');
  }

  // ---- 2b. a NON-JSON rejection (a framework error page) has no names to project ----
  {
    const { log, a } = rejectingAdapter(`<html><body>ActionView::Template::Error ${SENTINEL}</body></html>`);
    await a.login();
    const r = await a.placeBid('ENQ-1', 98000, { floor: 50000 });
    ok(r.reason === 'http_422', `an unprojectable body is recorded as its status alone (got ${JSON.stringify(r.reason)})`);
    ok(!String(r.reason).includes(SENTINEL) && !JSON.stringify(r.raw || '').includes(SENTINEL) && !log.text().includes(SENTINEL),
      'the page body reaches neither the return value nor the log');
  }

  // ---- 2c. an allowlisted field is still bounded - the leak was unbounded egress, not one key ----
  {
    const huge = 'x'.repeat(5000);
    const projected = projectSubmitError({ message: huge });
    ok(projected.length <= SUBMIT_ERROR_MAX_CHARS + 3,
      `an arbitrarily long allowlisted field is truncated (got ${projected.length} chars)`);
    ok(projectSubmitError({ created_by: { password_digest: SENTINEL } }) === null,
      'a body carrying only unallowlisted keys projects to nothing at all');
    ok(projectSubmitError('a plaintext refusal') === null, 'a bare string has no names to project');
  }

  // ---- 2d. the ACCEPTED path is unchanged - it carries our own quote back, as before ----
  {
    const fetchImpl = async (url, init) => {
      if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quoteDoc()]);
      if (init.method === 'PUT') return resp(200, { data: { quote_rank: 1, can_submit_quote: true } });
      return resp(404, {});
    };
    const a = new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl, sleep: noSleep });
    await a.login();
    const r = await a.placeBid('ENQ-1', 98000, { floor: 50000 });
    ok(r.accepted === true && r.reason === null, 'an accepted bid carries no reason');
    ok(r.raw && r.raw.quote_rank === 1, 'and still carries the server object the caller reads its rank from');
  }

  // =============================================================================================
  // PART 3 - THE UNENFORCED CEILING
  // =============================================================================================

  const CEILING = 40000;
  const KEY = 'ENQ-3260-20-14';

  /** A listing + detail pair carrying whatever ceiling_rate the case needs. */
  function listingAdapter(ceilingRate, { bidEnabled = true } = {}) {
    const base = Date.now();
    const puts = [];
    const fetchImpl = async (url, init) => {
      if (url.includes('/enquiries/spot')) {
        return resp(200, { data: { total_page: 1, enquiries: [{
          key: KEY, origin: 'CHENNAI', destination: 'PUNE', mode: 'FTL', bidding_closed: false,
          bid_close_timestamp: new Date(base + 3600_000).toISOString(), client_company_name: 'Waaree Energies Ltd.',
        }] } });
      }
      if (new RegExp(`/enquiries/${KEY}$`).test(url)) {
        return resp(200, { data: { cargo_quantity: 1.0, cargo_unit: 'TRUCK', slab_rate: 500.0, ceiling_rate: ceilingRate } });
      }
      if (init.method === 'GET' && url.includes('/quotes')) {
        return resp(200, [{ id: 'QC', charges_list: { '11_freight_charges': {
          freight_charges_custom_charge_x: { units: 1, unit_name: 'TRUCK', price: 1 },
        } }, total_charges: { total: { units: 1.0, quote_units: 1.0, unit_name: 'TRUCK' } } }]);
      }
      if (init.method === 'PUT') { puts.push(JSON.parse(init.body)); return resp(200, { data: { quote_rank: 1 } }); }
      return resp(404, {});
    };
    return { puts, a: new GoCometAdapter({ token: validToken(), bidEnabled, fetchImpl, sleep: noSleep }) };
  }

  // ---- 3a. the cached ceiling now reaches the load in the shape both defences read ----
  {
    const { a } = listingAdapter(CEILING);
    await a.login();
    const [load] = await a.listAuctions();
    ok(load.rules && load.rules.ceilingPrice === CEILING,
      `the enquiry's ceiling_rate reaches rules.ceilingPrice (got ${JSON.stringify(load.rules)})`);
    ok(load.rules.minDecrement === 500, 'and the decrement rule it used to be alone on is untouched');
    ok(plausibleCeiling(load.rules.ceilingPrice) === CEILING,
      'the published value passes the same plausibility gate the engine and the belt both apply');
  }

  // ---- 3b. the ENGINE caps the ladder from it - the SuperProcure defence, not a GoComet copy ----
  {
    const f = path.join(os.tmpdir(), `gc-ceiling-${process.pid}.json`);
    try { fs.unlinkSync(f); } catch (_e) {}
    const stub = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 500, revisionLimit: 3, closeModel: 'soft' }),
      ensureSession: async () => ({}), writeEnabled: true,
      getAuctionState: async () => ({ ok: true, status: 'live', closesInMs: 600000 }),
      placeBid: async () => ({ accepted: true }),
    };
    const engine = new BidEngine(stub, new DurableScheduler(f), { config: { minInterFireMs: 0 }, onEvent: () => {} });
    const meta = { id: KEY, lane: { origin: 'CHENNAI', destination: 'PUNE' }, rules: { minDecrement: 500, ceilingPrice: CEILING } };
    const inputs = { cost: 30000, marginsPct: [300, 100, 33], minMarginPct: 33 };
    const capped = engine.planPreview(meta, inputs);
    const uncapped = engine.planPreview({ id: KEY, lane: meta.lane, rules: { minDecrement: 500 } }, inputs);
    ok(uncapped.ladder[0] > CEILING, `precondition: without a ceiling the opening rung is over it (${uncapped.ladder[0]})`);
    ok(capped.ceiling === CEILING && capped.ladder.every((r) => r <= CEILING),
      `capLadderToCeiling runs on a GoComet load and no rung exceeds the ceiling (${JSON.stringify(capped.ladder)})`);
    ok(capped.ladder[capped.ladder.length - 1] === capped.floor,
      'and the cap never touches the floor rung - the hard floor invariant survives it');
    try { fs.unlinkSync(f); } catch (_e) {}
  }

  // ---- 3c. the ADAPTER belt refuses an over-ceiling amount before anything reaches the wire ----
  {
    const { a, puts } = listingAdapter(CEILING);
    await a.login();
    const [load] = await a.listAuctions();
    let err = null;
    // exactly the opts the engine builds: the load's rules spread, plus the operating floor.
    try { await a.placeBid(KEY, 120000, Object.assign({}, load.rules, { floor: 30000 })); } catch (e) { err = e; }
    ok(err && err.code === 'CEILING', `an over-ceiling amount is refused at the adapter boundary (got ${err && err.code})`);
    ok(puts.length === 0, 'and no PUT is issued, so the rung is not spent on a bid the shipper will not consider');
  }

  // ---- 3d. NO ceiling means NO assertion, not a refused bid ----
  // assertBelowCeiling throws on a null ceiling (`!(price <= null)` is true for any positive
  // price), so this is the case that decides whether wiring the belt in costs every bid on the
  // portal - ceiling_rate is null on all 11 observed enquiries, so it is also the common case.
  {
    for (const raw of [null, undefined, '', 0, -1, 'n/a', 2e9]) {
      const { a, puts } = listingAdapter(raw === undefined ? undefined : raw);
      await a.login();
      const [load] = await a.listAuctions();
      const opts = Object.assign({}, load && load.rules, { floor: 30000 });
      let err = null;
      try { await a.placeBid(KEY, 120000, opts); } catch (e) { err = e; }
      ok(err === null && puts.length === 1,
        `ceiling_rate ${JSON.stringify(raw)} is "no cap", and the bid goes out untouched (err=${err && err.code})`);
    }
  }

  // ---- 3e. a ceiling AT the amount is legal; one rupee over is not ----
  {
    const { a, puts } = listingAdapter(CEILING);
    await a.login();
    const [load] = await a.listAuctions();
    const opts = Object.assign({}, load.rules, { floor: 30000 });
    const r = await a.placeBid(KEY, CEILING, opts);
    ok(r.accepted === true && puts.length === 1, 'bidding exactly the ceiling is allowed');
    let err = null;
    try { await a.placeBid(KEY, CEILING + 1, opts); } catch (e) { err = e; }
    ok(err && err.code === 'CEILING', 'one rupee above it is not');
  }

  assert.strictEqual(fail, 0, `${fail} GoComet write-path checks failed`);

  // COMPLETION SENTINEL - not decoration, and do not delete it as redundant.
  // scripts/run-tests.js grades every test file by its EXIT CODE ALONE, so a file that exits 0
  // early - an early return, an unref'd timer, an async path that never resolves - scores as a
  // PASS having asserted nothing. The `fail === 0` assert above cannot catch that, because a run
  // that never reached its assertions also never incremented `fail`. Asserting a FLOOR on the
  // number of checks that ran is what makes a silent zero-assertion run impossible. Raise it
  // whenever checks are added.
  const MIN_EXPECTED_CHECKS = 32;
  assert.ok(pass >= MIN_EXPECTED_CHECKS,
    `completion sentinel: only ${pass} checks ran, expected at least ${MIN_EXPECTED_CHECKS} - the suite exited early and would otherwise have scored as a silent green`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
