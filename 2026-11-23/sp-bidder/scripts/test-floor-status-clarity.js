'use strict';
/**
 * One load, one story. Load 25118167 (Havells, 8 Sep, soft close) put three descriptions of a
 * single event in front of the desk:
 *   - the load's bid bubble logged "Bids placed (live)" at 11:14:58.690Z
 *   - a desk notice said "Lowest price sent - nothing left in reserve" at 11:14:58.696Z
 *   - the load's own web page said "Cost had to be entered by 4:43 PM" on a load whose cost WAS
 *     entered, at 16:41 IST, two and a half minutes inside that cutoff
 * All three were produced by subsystems unaware of each other, and every one of them was
 * individually defensible. The rank the desk actually needed - 9 - was received and stored and
 * appeared on none of them, and the two live CSV exporters disagreed about it ('' against 9).
 *
 * This file pins the repair from five directions:
 *   1. the notice's copy states the bid, not a second status, and never says "reserve"
 *   2. the notice CARRIES the position - landedBids and myRank, both null before this change
 *   3. the engine emits both, with the rank the platform returned for the bid the notice is about
 *   4. a priced load's page no longer claims its cost deadline was missed
 *   5. both exporters answer the rank question with one expression
 * Plus the control: reaching the floor WITHOUT the last-resort release produces no notice at all,
 * which is what separates load 25106748 from 25118167 and is the property a wider fix would break.
 *
 *   node scripts/test-floor-status-clarity.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const assert = require('assert');
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-floor-status-'));

const http = require('http');
const { renderMessage } = require('../src/notify/waTemplates');
const { toNotification } = require('../src/notify/engineAlerts');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const tmp = (tag) => path.join(os.tmpdir(), `floor-status-${tag}-${process.pid}.json`);
const rm = (f) => { try { fs.unlinkSync(f); } catch (_) { /* best effort */ } };

// The real load's shape: three bids landed, rank 9, floor released as the last resort.
const NOTICE = {
  type: 'alert', level: 'warn', kind: 'last_resort_floor_fired', auctionId: '25118167',
  lane: { origin: 'Alwar', destination: 'Bhiwandi' }, companyName: 'Havells', branchName: 'Alwar',
  floor: 55577, myRank: 9, landedBids: 3, remainingMs: 1800,
  detail: 'every soft-close defend path held on the final tick with the floor rung unspent',
};

function req(method, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => resolve({ status: res.statusCode, text: buf })); });
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  // ---------------------------------------------------------------------------------------------
  // 1. The copy. One statement about one bid, in the desk's words.
  // ---------------------------------------------------------------------------------------------
  {
    const n = toNotification(NOTICE);
    assert.ok(n && n.kind === 'desk_notice', 'the alert still routes to the customer group');
    const body = renderMessage('desk_notice', n.data);

    // The headline is WhatsApp's chat-list preview - it is read alone, before anything under it.
    // "Lowest price sent" read as a different status from the bubble's "Bids placed (live)".
    assert.ok(body.includes('Final bid placed'), 'the headline says a bid was placed, like the bubble does');
    assert.ok(body.includes('this was our lowest, nothing more goes out on this load'),
      'and adds the one fact the bubble cannot carry');
    assert.ok(body.includes('Havells'), 'the customer is named in the preview line');

    // The banned vocabulary. "reserve" is our own pricing language, and the desk read the number
    // under "our lowest price on this load" as a ceiling the customer had set.
    assert.ok(!/reserve/i.test(body), 'the notice never says "reserve"');
    assert.ok(!/\bband\b/i.test(body), 'the notice never says "band"');
    assert.ok(!/\bfloor\b/i.test(body), 'the notice never says "floor"');
    assert.ok(!/lowest price on this load/i.test(body),
      'money we SENT is not labelled as a price we might send - that label is what read as a ceiling');
    assert.ok(!/[—–]/.test(body), 'no em or en dashes - this is pasted into WhatsApp');

    // The closing line, compressed (F-E, 2026-09-11), then trimmed again (ship review,
    // 2026-09-16) because "nothing more goes out on this load" already opens the headline - the
    // closing line restated it, so the same short message said one thing twice. What is left is
    // the one fact the headline does not carry: the answer arrives at close.
    const closing = body.split('\n').filter((l) => /^_.*_$/.test(l));
    assert.strictEqual(closing.length, 1, 'exactly one closing italic line');
    assert.strictEqual(closing[0], '_The result will follow at close._',
      `the closing line adds only what the headline lacks (got: ${closing[0]})`);
    assert.ok(!/We held as long as we could/.test(body), 'the self-justifying clause is gone');
    assert.ok(!/nothing more goes out on this load/i.test(closing[0]),
      'the closing line does not repeat the headline\'s own words');
    ok('the notice states a placed bid, not a second status, and drops the vocabulary that misled');
  }

  {
    // THE POSITION. Both numbers were null on the real load while three bids stood at rank 9.
    const n = toNotification(NOTICE);
    assert.strictEqual(n.data.landedBids, 3, 'the notice payload carries the standing bid count');
    assert.strictEqual(n.data.myRank, 9, 'the notice payload carries our rank');
    const body = renderMessage('desk_notice', n.data);
    assert.ok(body.includes('Bids placed on this load* - 3'), 'the count renders, so this lines up with the bid log');
    assert.ok(/Where we stand now\* - 9/.test(body), 'the rank renders');
    assert.ok(body.includes('Bid sent* - ₹55,577'), 'the money line says what the number is');
    ok('the notice carries non-null landedBids and myRank, and renders both');
  }

  {
    // A rank the platform never sent is OMITTED, never invented or dashed. Same rule the quantity
    // lines follow: a desk notice states a number it was given or says nothing.
    const n = toNotification(Object.assign({}, NOTICE, { myRank: null, landedBids: 0 }));
    assert.strictEqual(n.data.myRank, null);
    const body = renderMessage('desk_notice', n.data);
    assert.ok(!/Where we stand now/.test(body), 'no rank line when no rank was received');
    assert.ok(!/Bids placed on this load/.test(body), 'no count line when nothing landed');
    assert.ok(body.includes('Final bid placed'), 'the headline still stands on its own');
    ok('an unknown rank or count is omitted rather than printed as a placeholder');
  }

  {
    // The three sibling desk notices must be untouched. deskNoticeMoney is shared, and the money
    // label is branched on reason - a branch that leaked would relabel a refusal's money as a bid.
    const ceiling = toNotification({ type: 'alert', level: 'warn', kind: 'ceiling_below_floor',
      auctionId: 'C1', lane: { origin: 'A', destination: 'B' }, companyName: 'Sika',
      ceiling: 40000, floor: 42000 });
    const body = renderMessage('desk_notice', ceiling.data);
    assert.ok(body.includes('Our lowest price on this load* - ₹42,000'),
      'a refusal still labels the floor as a price we did not send');
    assert.ok(body.includes('Not bidding'), 'and still leads as a refusal');
    assert.ok(!/Where we stand now/.test(body), 'and gains no rank line');
    ok('the sibling desk notices keep their own money label and gain nothing');
  }

  // ---------------------------------------------------------------------------------------------
  // 2. The engine emits what the notice needs, and only on the last-resort release.
  // ---------------------------------------------------------------------------------------------
  {
    const f = tmp('engine');
    const events = [];
    const CFG = { openAtMs: 25000, floorWindowMs: 2500, minInterFireMs: 0 };
    const BAND = { cost: 50000, marginsPct: [14, 11.5, 11.2], minMarginPct: 11.2 };
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'soft' }),
      ensureSession: async () => ({}),
      writeEnabled: true,
      async getAuctionState() { return { ok: true, status: 'live', myRank: 4, totalBidders: 9,
        standingL1Price: null, closesInMs: 1200, revisionLimit: 3, revisionsLeft: 1,
        minDecrement: 100, closeModel: 'soft', measuredRttMs: 50 }; },
      // The platform's answer to the write. It is one bid fresher than the read that decided it,
      // and it is the rank the desk is being told about.
      async placeBid() { return { accepted: true, myRank: 9, revisionsLeft: 0, latencyMs: 20 }; },
    };
    const eng = new BidEngine(adapter, new DurableScheduler(f),
      { config: CFG, rand: () => 0, onEvent: (e) => events.push(e),
        softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 } });
    const m = eng.arm({ id: '25118167', lane: { origin: 'Alwar', destination: 'Bhiwandi' }, units: 1,
      companyName: 'Havells', branchName: 'Alwar', closesAt: Date.now() + 3000 }, BAND);
    // Two bids on the board, the soft-close defend still HOLDING (extensions remain, so the branch
    // that owns the decision wants to wait for the next round), and the last tick has arrived. That
    // is the exact state _lastResortFloor exists for: hold, and the load closes with the reserved
    // rung unspent. Extensions exhausted would instead route to the ordinary snipe, which is the
    // control below.
    m.closeModel = 'soft'; m.extendCap = 3; m.extendsObserved = 0;
    m.currentRungIndex = 1; m.firedRungs.add(0); m.firedRungs.add(1);
    m.landedBids = 2; m.lastBidPrice = m.ladder[1]; m.revisionsLeft = 1;
    await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    eng.kill(); rm(f);

    const fired = events.filter((e) => e.type === 'alert' && e.kind === 'last_resort_floor_fired');
    assert.strictEqual(fired.length, 1, 'the last-resort release fired exactly once');
    assert.strictEqual(fired[0].landedBids, 3, 'the emit counts the bid it is about');
    assert.strictEqual(fired[0].myRank, 9,
      'the emit carries the rank the PLATFORM returned for this bid, not the read that preceded it');
    assert.strictEqual(fired[0].floor, m.ladder[m.ladder.length - 1], 'and the price that went');
    ok('the engine emits landedBids and the post-bid rank on the last-resort release');
  }

  {
    // THE CONTROL - load 25106748. It reached the floor rung through the ordinary rank-aware snipe
    // rather than the last-resort release, and produced zero desk notices. Reaching the floor does
    // not make the pair; reaching it THROUGH _lastResortFloor does, and that distinction is what a
    // broader "tell the desk when we hit the floor" change would destroy.
    const f = tmp('control');
    const events = [];
    const CFG = { openAtMs: 25000, floorWindowMs: 2500, minInterFireMs: 0 };
    const BAND = { cost: 50000, marginsPct: [14, 11.5, 11.2], minMarginPct: 11.2 };
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      writeEnabled: true,
      async getAuctionState() { return { ok: true, status: 'live', myRank: 3, totalBidders: 6,
        standingL1Price: null, closesInMs: 1200, revisionLimit: 3, revisionsLeft: 2,
        minDecrement: 100, closeModel: 'hard', measuredRttMs: 50 }; },
      async placeBid() { return { accepted: true, myRank: 1, revisionsLeft: 1, latencyMs: 20 }; },
    };
    const eng = new BidEngine(adapter, new DurableScheduler(f),
      { config: CFG, rand: () => 0, onEvent: (e) => events.push(e) });
    const m = eng.arm({ id: '25106748', lane: { origin: 'Bhiwandi', destination: 'Pune' }, units: 1,
      companyName: 'Payal Polyplast', closesAt: Date.now() + 2000 }, BAND);
    m.currentRungIndex = 0; m.firedRungs.add(0); m.landedBids = 1; m.lastBidPrice = m.ladder[0];
    await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    eng.kill(); rm(f);

    const placed = events.filter((e) => e.type === 'bid_placed');
    assert.ok(placed.length > 0, 'precondition: the snipe placed the floor rung');
    assert.strictEqual(placed[placed.length - 1].price, m.ladder[m.ladder.length - 1],
      'precondition: it reached the floor');
    const notices = events.filter((e) => e.type === 'alert'
      && ['last_resort_floor_fired', 'ceiling_below_floor', 'load_not_biddable'].includes(e.kind));
    assert.deepStrictEqual(notices, [], 'the control load still produces zero desk notices');
    ok('the control load reaches the floor through the ordinary snipe and notifies nobody');
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Both exporters answer the rank question with one expression.
  // ---------------------------------------------------------------------------------------------
  {
    // The real divergence: the legacy exporter read only `rank` (absent on these bids) while the
    // newer one falls back to `socketRank`, so one file said '' and the other said 9 for the
    // identical bid. Two exports of one system disagreeing on a number is the thing the desk
    // reports as the data coming out wrong.
    const bid = { ts: Date.now(), rungIndex: 2, price: 55577, rank: null, socketRank: 9, latencyMs: 20 };
    const exportsSrc = fs.readFileSync(path.join(__dirname, '..', 'src/web/exports.js'), 'utf8');
    const modelSrc = fs.readFileSync(path.join(__dirname, '..', 'src/web/exportModel.js'), 'utf8');
    const EXPR = /b\.socketRank != null \? b\.socketRank : \(b\.rank != null \? b\.rank : ''\)/;
    assert.ok(EXPR.test(exportsSrc), 'the legacy exporter applies the socketRank fallback');
    assert.ok(EXPR.test(modelSrc), 'the newer exporter uses the identical expression');

    // Behaviour, not only text: run the expression both files now hold against the real bid.
    const rankOf = (b) => (b.socketRank != null ? b.socketRank : (b.rank != null ? b.rank : ''));
    assert.strictEqual(rankOf(bid), 9, 'a bid whose rank only ever arrived on the socket exports as 9');
    assert.strictEqual(rankOf({ rank: 2, socketRank: null }), 2, 'a response rank still exports');
    assert.strictEqual(rankOf({ rank: null, socketRank: null }), '', 'no rank anywhere still exports blank');
    ok('both exporters resolve a bid rank through the same expression and agree on load 25118167');
  }

  // ---------------------------------------------------------------------------------------------
  // 4. A priced load's page no longer claims its cost deadline was missed.
  // ---------------------------------------------------------------------------------------------
  {
    const { app, requests } = require('../src/web/server');
    const { publicSeg } = require('../src/pricing/priceRequests');
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const now = Date.now();
    const mkLoad = (id) => ({ id, lane: { origin: 'Alwar', destination: 'Bhiwandi' }, equipment: 'Trailer',
      units: 1, companyName: 'Havells', closesAt: now + 10 * 60_000, startsAt: now - 60_000,
      softClose: false, status: 'live' });

    // NOT priced: the deadline is a live fact and the line is the only thing that states it.
    const rA = await requests.createForLoad(mkLoad('FSC-1'), { deadlineAt: now + 60_000 });
    const unpriced = await req('GET', `${base}/track/${publicSeg(rA)}`);
    assert.strictEqual(unpriced.status, 200);
    assert.ok(/Cost had to be entered by/.test(unpriced.text),
      'an unpriced load still tells the desk what its cutoff was');

    // PRICED: the cost went in inside the cutoff, which is the real load's case exactly.
    const rB = await requests.createForLoad(mkLoad('FSC-2'), { deadlineAt: now + 60_000 });
    await requests.capture(rB.id, { cost: 50000 });
    const priced = await req('GET', `${base}/track/${publicSeg(rB)}`);
    assert.strictEqual(priced.status, 200);
    assert.ok(!/Cost had to be entered by/.test(priced.text),
      'a load whose cost WAS entered never claims its cost deadline was missed');
    ok('the past-tense cutoff label is gone from a captured-and-bid load and kept where it is true');

    // And the /price re-price page carries the live position its own WhatsApp link promises.
    const form = await req('GET', `${base}/price/${rB.id}`);
    assert.strictEqual(form.status, 200);
    assert.ok(/id="livepos"/.test(form.text), 'the re-price page has a live-position slot');
    assert.ok(/We are at number/.test(form.text) && /our last bid was Rs/.test(form.text),
      'and the page ships the code that fills it, so the link no longer promises a number it lacks');
    const state = await req('GET', `${base}/price/${rB.id}/state`);
    const s = JSON.parse(state.text);
    assert.ok('myRank' in s && 'lastBidPrice' in s, 'the poller source serves the position');
    ok('the re-price page carries the live rank its WhatsApp link promises');

    await new Promise((r) => server.close(r));
  }

  console.log(`\n${pass}/9 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
