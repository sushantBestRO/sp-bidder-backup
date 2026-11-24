'use strict';
/**
 * CW-229 - /track's pre-first-bid state.
 *
 * fix/gocomet-close-timing (d94410d) opens a ~49.5s-to-several-minute window on a non-allowlisted
 * soft-close (GoComet-shaped) load in which a monitor exists, is armed and scheduled, and has NO
 * bid on the board yet. /track's bare "Bidding live" / "Last bid -" trio reads as a hung system in
 * exactly that window (r5 master-review.md, "Open, not blocking"; UX_FEEDBACK.md section 2.1-2.3).
 *
 * This file proves three layers:
 *   A. bidEngine._pendingFirstBidAtMs / snapshot().firstBidByMs - the new display-only field,
 *      scoped to exactly the population the establish hold gates.
 *   B. server.js trackState() - the field reaches the /track/:token/state JSON, through the real
 *      HTTP route, off the real live engine (stacks[0].engine.monitors), and disappears once a bid
 *      lands.
 *   C. the shipped client-side render() script - the ACTUAL <script> the page serves, not a
 *      re-implementation of it (test-track-page.js's own rationale for this pattern), renders the
 *      "First bid goes in by <time>" line pre-bid and the untouched "Bidding live" trio post-bid.
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-track-prebid-'));

const assert = require('assert');
const http = require('http');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

let seq = 0;
const tmp = () => path.join(os.tmpdir(), `track-prebid-${process.pid}-${seq++}.json`);
const CLEAN = [];

function req(method, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    r.end();
  });
}
function postForm(base, p, kv) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const body = new URLSearchParams(kv).toString();
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } },
    (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    r.end(body);
  });
}

// A GoComet-shaped monitor: rank-only, soft close, empty allowlist (softStrategy resolves 'off').
function mkEngine() {
  const f = tmp(); CLEAN.push(f);
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 1000, revisionLimit: 3, closeModel: 'soft' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('placeBid must not be reached'); },
  };
  return new BidEngine(adapter, new DurableScheduler(f), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, rungs: 6, softOpenAtMs: 150_000, softOpenJitterMs: 15_000 },
    softClose: { enabled: false, shippers: [], mode: 'live' },
    rand: () => 0.5,
    onEvent: () => {},
  });
}
function armLoad(eng, { companyName = 'Waaree', closeModel = 'soft', closesAt = Date.now() + 3_600_000 } = {}) {
  const meta = { id: String(++seq), lane: { origin: 'Degam', destination: 'Vadodara' }, units: 1, companyName, closesAt };
  const m = eng.arm(meta, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = closeModel;
  return m;
}

(async () => {
  console.log('\nCW-229: /track pre-first-bid state\n');

  // =====================================================================================
  // A. bidEngine: _pendingFirstBidAtMs / snapshot().firstBidByMs
  // =====================================================================================

  {
    const eng = mkEngine();
    const m = armLoad(eng);
    const mark = eng._softEstablishThreshold(m);
    const expected = m.meta.closesAt - mark;
    ok(eng._pendingFirstBidAtMs(m) === expected,
      `non-allowlisted soft, unbid: firstBidAt should be closesAt-mark (${expected}), got ${eng._pendingFirstBidAtMs(m)}`);
    ok(eng.snapshot().find((x) => x.auctionId === m.auctionId).firstBidByMs === expected,
      'snapshot() surfaces the same value the direct method computes');
  }

  {
    // once a bid lands (lastBidPrice set), the field must disappear - "today's" trio takes over.
    const eng = mkEngine();
    const m = armLoad(eng);
    ok(eng._pendingFirstBidAtMs(m) != null, 'precondition: unbid load has a pending mark');
    m.lastBidPrice = 71_000;
    ok(eng._pendingFirstBidAtMs(m) === null, 'a landed bid clears firstBidByMs');
    ok(eng.snapshot().find((x) => x.auctionId === m.auctionId).firstBidByMs === null,
      'snapshot() reflects the cleared field too');
  }

  {
    // hard close: the establish fires near-instantly on main/unaffected paths - no scheduled mark.
    const eng = mkEngine();
    const m = armLoad(eng, { closeModel: 'hard' });
    ok(eng._pendingFirstBidAtMs(m) === null, 'hard-close load reports no pending first-bid mark');
  }

  {
    // allowlisted soft (rank-driven endgame): a different, opt-in mark shape - not this fix's hold.
    const f = tmp(); CLEAN.push(f);
    const eng = new BidEngine({
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 1000, revisionLimit: 30, closeModel: 'soft' }),
      ensureSession: async () => ({}), getAuctionState: async () => ({ ok: false }),
      placeBid: async () => { throw new Error('unreachable'); },
    }, new DurableScheduler(f), {
      config: { openAtMs: 25_000, floorWindowMs: 2_500, rungs: 6, softOpenAtMs: 150_000 },
      softClose: { enabled: true, shippers: ['Havells'], mode: 'live' },
      onEvent: () => {},
    });
    const m = armLoad(eng, { companyName: 'Havells' });
    assert.notStrictEqual(m.softStrategy, 'off', 'precondition: this fixture is on the allowlist');
    ok(eng._pendingFirstBidAtMs(m) === null, 'allowlisted soft-close load reports no pending mark (different, unrelated timing)');
  }

  {
    // unknown/unreadable close time: no fabricated field.
    const eng = mkEngine();
    const m = armLoad(eng, { closesAt: NaN });
    ok(eng._pendingFirstBidAtMs(m) === null, 'a load with no readable closesAt reports null, never a guessed time');
  }

  {
    // the mark re-derives live off believedCloseAt - a confirmed extension moves ONLY that field,
    // never meta.closesAt (the arm-time close, stale by design - see raiseAuthDeadIfLoggedOut's own
    // comment on this exact idiom). Mutating meta.closesAt alone must NOT move the shown time.
    const eng = mkEngine();
    const m = armLoad(eng);
    const before = eng._pendingFirstBidAtMs(m);
    m.meta.closesAt += 299_000; // must be ignored - this is the stale arm-time close
    ok(eng._pendingFirstBidAtMs(m) === before, 'mutating meta.closesAt alone must not move the shown time');
    m.believedCloseAt += 299_000; // one GoComet extension increment, the live close
    const after = eng._pendingFirstBidAtMs(m);
    ok(after === before + 299_000, `a confirmed extension must shift the shown time by the same amount (before ${before}, after ${after})`);
  }

  // =====================================================================================
  // B. server.js: trackState() carries the field over HTTP, off the REAL live engine
  // =====================================================================================

  const { app, requests, stacks } = require('../src/web/server');
  const { armFromRequest } = require('../src/pricing/priceRequests');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const liveEngine = stacks[0].engine; // mock SP stack, built at module load (server.js:737-748)

  const now = Date.now();
  const rG0 = await requests.createForLoad({
    id: 'TRK-PB-GC', lane: { origin: 'Degam', destination: 'Vadodara' }, equipment: '32ft MXL',
    units: 1, companyName: 'Waaree', closesAt: now + 3_600_000, startsAt: now - 60_000,
    softClose: true, status: 'live',
  });
  // Armed directly (armFromRequest), same as seedDemoLiveAuctions() - a soft-close load's own
  // /price HTTP route is gated by the hardCloseOnly allowlist scope guard (server.js:2641), a
  // separate concern from this fix that would otherwise 409 every fixture in this section.
  const rG = await requests.capture(rG0.id, { cost: 70_000 });
  armFromRequest(liveEngine, rG);
  const monG = liveEngine.monitors.get('TRK-PB-GC');
  ok(!!monG, 'precondition: arming created a live monitor for the GoComet-shaped load');
  monG.closeModel = 'soft'; // the mock adapter reports 'unknown' before its first tick; force the shape under test

  const sPre = await req('GET', `${base}/track/${rG.id}/state`);
  ok(sPre.json.engine && sPre.json.engine.lastBidPrice == null, 'precondition: no bid has landed yet');
  ok(typeof sPre.json.engine.firstBidByMs === 'number', 'the /track state JSON carries firstBidByMs pre-bid');
  const expectedMark = monG.meta.closesAt - liveEngine._softEstablishThreshold(monG);
  ok(sPre.json.engine.firstBidByMs === expectedMark,
    `firstBidByMs (${sPre.json.engine.firstBidByMs}) should match the engine's own mark (${expectedMark})`);

  monG.lastBidPrice = 71_500; // simulate a landed bid
  const sPost = await req('GET', `${base}/track/${rG.id}/state`);
  ok(sPost.json.engine.lastBidPrice === 71_500, 'state reflects the landed bid');
  ok(sPost.json.engine.firstBidByMs === null, 'firstBidByMs disappears once a bid has landed');

  // a hard-close (unaffected, "today's behaviour") load never carries the field at all
  const rH = await requests.createForLoad({
    id: 'TRK-PB-HARD', lane: { origin: 'Bhiwandi, MH', destination: 'Bawal, HR' }, equipment: '20ft container',
    units: 1, companyName: 'Syngenta India', closesAt: now + 3_600_000, startsAt: now - 60_000,
    softClose: false, status: 'live',
  });
  await postForm(base, `/price/${rH.id}`, { cost: '58000' });
  const sHard = await req('GET', `${base}/track/${rH.id}/state`);
  ok(sHard.json.engine && sHard.json.engine.lastBidPrice == null, 'precondition: hard-close load also unbid yet');
  ok(sHard.json.engine.firstBidByMs === null, 'a load without a scheduled establish hold never gets a fabricated firstBidByMs');

  // =====================================================================================
  // C. the shipped client-side render() script
  // =====================================================================================

  function extractRenderScript(html) {
    const blocks = [];
    const re = /<script>([\s\S]*?)<\/script>/g;
    for (let m = re.exec(html); m; m = re.exec(html)) blocks.push(m[1]);
    return blocks.filter((b) => /function render\(/.test(b)).pop();
  }
  async function renderState(html, state) {
    const src = extractRenderScript(html);
    const statEl = { innerHTML: '' };
    const cdEl = { style: {}, textContent: '', getAttribute: () => String(Date.now() + 60_000) };
    const byId = { stat: statEl, cd: cdEl };
    const document = { getElementById: (id) => byId[id] || null };
    const location = { pathname: `/track/${rG.id}` };
    const fetchStub = () => Promise.resolve({ ok: true, json: () => Promise.resolve(state) });
    const noop = () => {};
    function DateStub(...a) { return new Date(...a); }
    DateStub.now = () => Date.now();
    // eslint-disable-next-line no-new-func
    new Function('document', 'location', 'fetch', 'setTimeout', 'setInterval', 'Date', src)(
      document, location, fetchStub, noop, noop, DateStub,
    );
    for (let i = 0; i < 8; i++) await Promise.resolve();
    return statEl.innerHTML;
  }

  const trackHtml = (await req('GET', `${base}/track/${rG.id}`)).text;
  ok(!!extractRenderScript(trackHtml), 'track page carries the render() script to test against');

  // 9:42 am local, matching the r5/UX_FEEDBACK worked example
  const nineFortyTwoAm = new Date();
  nineFortyTwoAm.setHours(9, 42, 0, 0);
  const preBid = await renderState(trackHtml, { engine: { status: 'bidding', myRank: 2, lastBidPrice: null, firstBidByMs: nineFortyTwoAm.getTime() } });
  ok(/First bid goes in by 9:42 am/.test(preBid), `pre-bid state renders the exact copy form, got: ${preBid}`);
  ok(!/Bidding live/.test(preBid), 'pre-bid state does not also claim "Bidding live"');
  ok(!/Last bid/.test(preBid), 'pre-bid state does not print the bare "Last bid -" row');
  ok(!/Our rank/.test(preBid), 'pre-bid state does not print a rank with no bid behind it');

  const postBid = await renderState(trackHtml, { engine: { status: 'bidding', myRank: 1, lastBidPrice: 31_610, firstBidByMs: null } });
  ok(/Bidding live/.test(postBid), 'once a bid has landed, "Bidding live" renders exactly as before');
  ok(/Our rank/.test(postBid) && /1/.test(postBid), 'rank renders exactly as before once a bid has landed');
  ok(/Rs\s*31,610/.test(postBid), 'last bid price renders exactly as before once a bid has landed');
  ok(!/First bid goes in by/.test(postBid), 'the pre-bid line is gone once a bid has landed');

  // a monitor exists but no future mark was ever computed (hard-close / non-GoComet on main):
  // must render exactly as before the fix - the bare trio, not a fabricated wait state.
  const noMark = await renderState(trackHtml, { engine: { status: 'bidding', myRank: null, lastBidPrice: null, firstBidByMs: null } });
  ok(/Bidding live/.test(noMark), 'no scheduled mark: renders the unaffected "Bidding live" state');
  ok(/Last bid[^y]*-/.test(noMark), 'no scheduled mark: still shows the bare "Last bid -" - unaffected paths are untouched');
  ok(!/First bid goes in by/.test(noMark), 'no scheduled mark: never fabricates a wait line');

  // time-format spot checks: 12-hour, lowercase am/pm, no leading zero on the hour, matching the
  // page's copy convention ("9:42 am", not "09:42 AM" or "21:05").
  const mkTime = (h, mnt) => { const d = new Date(); d.setHours(h, mnt, 0, 0); return d.getTime(); };
  const fmt = async (h, mnt) => {
    const html = await renderState(trackHtml, { engine: { status: 'bidding', lastBidPrice: null, firstBidByMs: mkTime(h, mnt) } });
    const m = /First bid goes in by ([\d: apm]+)/.exec(html);
    return m ? m[1].trim() : null;
  };
  ok((await fmt(9, 42)) === '9:42 am', `9:42 should format as "9:42 am", got ${await fmt(9, 42)}`);
  ok((await fmt(21, 5)) === '9:05 pm', `21:05 should format as "9:05 pm", got ${await fmt(21, 5)}`);
  ok((await fmt(0, 0)) === '12:00 am', `midnight should format as "12:00 am", got ${await fmt(0, 0)}`);
  ok((await fmt(12, 0)) === '12:00 pm', `noon should format as "12:00 pm", got ${await fmt(12, 0)}`);

  server.close();
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }

  // COMPLETION SENTINEL - run-tests.js grades by exit status only.
  const EXPECTED_CHECKS = 34;
  const ran = pass + fail;
  if (ran !== EXPECTED_CHECKS) {
    console.error(`  FAIL - completion sentinel: ran ${ran} checks, expected ${EXPECTED_CHECKS}`);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  console.log(`\n${pass} passed, ${fail} failed (${ran}/${EXPECTED_CHECKS} checks reached the sentinel)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
