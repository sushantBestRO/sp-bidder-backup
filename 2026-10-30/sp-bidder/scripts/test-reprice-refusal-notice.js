'use strict';
/**
 * The two silences that let a below-cost bid run for 114 minutes on load 260908LD2Z (2026-09-08).
 *
 * The desk corrected a Rs 29,000 cost to Rs 38,000 with an hour fifty-four minutes of runway left.
 * A reverse auction takes only an improvement on our own standing bid, so every price the corrected
 * band could build sat above the Rs 31,610 already on the board and none of them could land. The
 * screen said "Saved - bidding off the new cost and margins now", a "New Market Rate Submitted"
 * receipt went to the desk's group carrying a ladder that could never be bid, and the engine's 42
 * refusals reached nobody: bid_rejected's only consumer was the logger, and toNotification had no
 * branch for a refusal kind at all.
 *
 * TWO INDEPENDENT PROPERTIES, and each is checked at the surface a human reads, never at the
 * object that carries it - the whole defect was a message that said something untrue, so a test
 * asserting a notification was merely constructed would have passed throughout the incident.
 *
 *   1. ROUTING + COPY: the engine's reprice_unreachable_ladder refusal reaches the desk as a NOTICE
 *      on the customer's own group, and what it says is true - our bid stands, the new rate cannot
 *      go on this load, the rate is not the problem, and if it wins it wins at the earlier price.
 *   2. THE CONFIRMATION: a re-price the system already knows will not bid must not be acknowledged
 *      as one that will. Driven over real HTTP against the PUBLIC /price/<token> form, which is the
 *      route the desk actually posts to.
 *
 *   node scripts/test-reprice-refusal-notice.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';    // no WhatsApp send from a unit test
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '0';
process.env.SP_MIN_PLAUSIBLE_COST = '1';
process.env.SP_MARGINS_PCT = '12,7,2';
process.env.SP_MIN_MARGIN_PCT = '2';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-reprice-notice-'));

const http = require('http');
const { toNotification, notifyEngineEvent, ERROR_KINDS, DESK_NOTICE_KINDS } = require('../src/notify/engineAlerts');
const { renderMessage } = require('../src/notify/waTemplates');
const { app, requests, notifier, stacks } = require('../src/web/server');

let pass = 0, fail = 0;
// ok(condition, name) - the CONDITION comes first. Sibling files in this directory define a
// name-only ok(name) that logs a pass having asserted nothing; writing ok(cond, name) into one of
// those is a silent green. Every call below passes a real condition.
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

// run-tests.js grades by EXIT STATUS ALONE, so a file that ends early reaches exit 0 having
// asserted nothing.
const EXPECTED_CHECKS = 109;
process.on('exit', () => {
  if (pass === EXPECTED_CHECKS && fail === 0) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks (${fail} failed), expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});

function req(method, url, { body = null, contentType = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType || 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => resolve({ status: res.statusCode, text: buf })); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

// The refusal event, field for field.
//
// NOTHING ON THIS BRANCH EMITS IT, and that is not an oversight - say it plainly here so the next
// reader does not go hunting. The producer is `bidEngine._holdAboveStandingBid` on
// fix/reprice-standing-bid (PR #219), which classifies the refusal and raises it once per held load;
// this branch is the consumer half and deliberately carries no engine change. Until #219 lands, the
// registration below is inert.
//
// The event is written out rather than driven through the engine on purpose: this file pins the
// CONSUMER's contract - routing and copy - and has to keep holding whichever code path produces the
// refusal. What it cannot prove is that a producer exists; that is #219's test to own.
const unreachableEvent = (over = {}) => Object.assign({
  type: 'alert', level: 'error', kind: 'reprice_unreachable_ladder',
  auctionId: '260908LD2Z', standingBidPrice: 31610, floor: 38684, opening: 41420,
  price: 41420, reachAt: 31609,
  // The desk's own corrected number, matching load 260908LD2Z's real incident figure - present by
  // default here because feat/reprice-record-and-hold is the state this fixture models going
  // forward; individual tests override it to null to pin the pre-#219-merge degrade.
  correctedCost: 38000,
  detail: 'the lowest price we can now bid (38684) does not improve on our standing bid 31610'
    + ' - this load cannot be bid again and nothing further will be sent',
  lane: { origin: 'Chikhli', destination: 'Hosur' },
  companyName: 'Waaree Energies Ltd.', branchName: '',
}, over);

// The ceiling stand-down alert, field for field, as bidEngine._decide's ceilingBelowFloor branch
// emits it (src/engine/bidEngine.js). cost is the entered rate that fed the dead plan - the figure
// the desk notice needs to name its own rupee exposure instead of leaving the two numbers below to
// be subtracted by hand.
const ceilingBelowFloorEvent = (over = {}) => Object.assign({
  type: 'alert', level: 'error', kind: 'ceiling_below_floor',
  auctionId: '260909CEIL', ceiling: 30000, floor: 30540, cost: 32700,
  detail: 'shipper ceiling 30000 is below the cost floor 30540 - cannot win profitably, not bidding',
  lane: { origin: 'Degam', destination: 'Kakinada' },
  companyName: 'Waaree Energies Ltd.', branchName: '',
}, over);

const CEILING = 26_000;
const LIVE_COST = '20000';   // floor 20,400 - well under the ceiling
const DEAD_COST = '27000';   // floor 27,540 - over the ceiling, no legal bid exists

const loadWithCeiling = (id) => ({
  id, companyName: 'Ceiling Co', equipment: '32 Feet', units: 1,
  lane: { origin: 'Pune', destination: 'Nashik' },
  closesAt: Date.now() + 45 * 60_000, startsAt: Date.now() - 60_000,
  softClose: false, closeModelKnown: true, status: 'live',
  rules: { ceilingPrice: CEILING, pricingMode: 'flat' },
});

async function main() {
  // ============================================================================================
  console.log('\n1. ROUTING - the refusal reaches the desk, on the customer\'s own group');
  // ============================================================================================
  {
    const n = toNotification(unreachableEvent());
    ok(n != null, 'the refusal produces a notification at all (it produced none before this change)');
    ok(n.kind === 'desk_notice',
      `it routes as a desk notice, not an ops error (got ${n && n.kind})`);
    ok(DESK_NOTICE_KINDS.has('reprice_unreachable_ladder'), 'the kind is registered as a desk notice');
    ok(!ERROR_KINDS.has('reprice_unreachable_ladder'),
      'and NOT as an error - the two sets must stay disjoint or the desk branch silently wins');

    // The scope keys are the whole reason this is a desk notice rather than an error: without a
    // shipper on the payload no customer-scoped group can ever match, and the notice falls back to
    // the unscoped all-loads recipients - the miss ceiling_below_floor had.
    ok(n.data.shipper === 'Waaree Energies Ltd.', 'the payload carries the shipper, so the customer group matches');
    ok(n.data.origin === 'Chikhli', 'and the origin');
    ok('branch' in n.data, 'and a branch key, so a branch-split load lands in its own group');
    ok(n.data.reason === 'reprice_unreachable_ladder', 'the reason rides through for the templates to dispatch on');
    ok(n.data.standingBidPrice === 31610, 'the standing bid rides through - it is the comparand the copy needs');
    ok(n.data.floor === 38684, 'as does the new band\'s lowest price');
    ok(n.data.correctedCost === 38000, 'and the desk\'s own corrected rate, for the redesigned copy');
  }

  {
    // The alert is latched per MONITOR and a re-price builds a new one, so a load re-priced twice
    // into unreachability emits twice. Same standing price -> same fact -> correctly swallowed.
    // A bid landing in between changes the number the desk is being told, and that must get through.
    const a = toNotification(unreachableEvent());
    const b = toNotification(unreachableEvent());
    ok(a.dedupeKey === b.dedupeKey, 'a repeat about the same standing price is one message, not two');
    const later = toNotification(unreachableEvent({ standingBidPrice: 30000 }));
    ok(later.dedupeKey !== a.dedupeKey,
      'but a DIFFERENT standing price is a different fact and is not swallowed as a duplicate');
    const other = toNotification(unreachableEvent({ auctionId: 'OTHER1' }));
    ok(other.dedupeKey !== a.dedupeKey, 'and the key is per load, so two held loads produce two notices');
  }

  // ============================================================================================
  console.log('\n2. THE COPY - MESSAGES_REDESIGN CW-225 section 2, verbatim');
  // ============================================================================================
  {
    const body = renderMessage('desk_notice', toNotification(unreachableEvent()).data);

    // The FIRST LINE is the WhatsApp chat-list preview and has to be true read entirely on its own.
    // A status, not a sentence - the customer name moves down beside the load id.
    const headline = body.split('\n')[0];
    ok(headline === '📌 *New rate saved. Bidding stopped on this load.*',
      `the headline is a complete status (got: ${headline})`);

    ok(/🆔 260908LD2Z · Waaree Energies Ltd\./.test(body), 'the id line carries the load id and customer, middot-joined');
    ok(/📍 Chikhli -> Hosur/.test(body), 'and the route, city to city');

    // Figure leads every line, bolded, label follows - the same inversion the redesign's page panel
    // makes, so the three numbers read in any order.
    ok(/\*₹31,610\* is our bid on the board/.test(body), 'the standing bid leads with the figure');
    ok(/\*₹38,000\* is your corrected rate/.test(body), 'the corrected rate leads with the figure');
    ok(/\*₹6,390\* under your rate if we win it/.test(body), 'and the gap is spelled out, figure first');

    // The WHY, in plain words and NOT in italics - F-B, 2026-09-11: the owner read the old body and
    // could not tell what it meant. The reverse-auction physics is now stated as the reason this
    // load stopped rather than as a standalone lesson in italics at the end.
    ok(/Your new rate is not below our bid already on the board, so we cannot bid it\./.test(body),
      'the reason is stated in plain words');
    ok(/Nothing further goes out on this load\./.test(body), 'and the consequence');
    ok(!/Reverse auction/i.test(body), 'the italic physics clause is gone - the reason line carries it');

    ok(/_Do not change this on the portal by hand\. It will not lower the bid and it uses up attempts\._/.test(body),
      'the do-not-hand-edit instruction stands alone');
    // One instruction, and it is that one.
    ok(body.split('\n').filter((l) => /^_.*_$/.test(l)).length === 1, 'exactly one italic paragraph');

    // G10's evidence base: this vocabulary lands on nobody.
    ok(!/\bband\b/i.test(body), 'never says "band"');
    ok(!/\bfloor\b/i.test(body), 'never says "floor"');
    ok(!/lowest price/i.test(body), 'never says "lowest price"');
    ok(!/%/.test(body), 'no percentages');
    ok(!/—/.test(body), 'no em dash - this is pasted into WhatsApp');
    ok(!/\bbots?\b/i.test(body), 'nothing here calls this system a bot');
    // This fires on GoComet and SuperProcure alike - the incident load was GoComet - so naming one
    // portal would be wrong on the other, and a guessed host is an inference this copy must not make.
    ok(!/SuperProcure|GoComet/i.test(body), 'it names no portal, because this refusal is not portal-specific');
    // Removed from this surface on 2026-07-27: the Director reads these and has no console.
    ok(!/console/i.test(body), 'it never asks anyone to open a console');
  }

  // ============================================================================================
  console.log('\n2b. CORRECTED COST ABSENT - the degraded body must still tell the whole story');
  // ============================================================================================
  {
    // #219 alone (no feat/reprice-record-and-hold) never sets correctedCost - the renderer must
    // still say something true rather than print "undefined" or "NaN".
    const body = renderMessage('desk_notice', toNotification(
      unreachableEvent({ correctedCost: null })).data);

    ok(/📌 \*New rate saved\. Bidding stopped on this load\.\*/.test(body), 'the headline still renders');
    ok(/\*₹31,610\* is our bid on the board/.test(body), 'the standing bid still renders');
    ok(!/is your corrected rate/.test(body), 'the corrected-rate line is dropped, not left blank');
    ok(!/under your rate if we win it/.test(body), 'the gap line goes with it - no corrected rate means no gap');
    ok(!/undefined|NaN/i.test(body), 'never prints undefined or NaN');

    // F-B, 2026-09-11: this is the variant the owner actually saw, and a saved-rate headline over a
    // lone board figure explained nothing. The reason line is not conditional on the corrected rate,
    // so the degraded body says why on its own.
    ok(/Your new rate is not below our bid already on the board, so we cannot bid it\./.test(body),
      'the reason is stated even with no corrected figure to show');
    ok(/Nothing further goes out on this load\./.test(body), 'and so is the consequence');
    ok(/_Do not change this on the portal by hand/.test(body), 'the instruction paragraph still renders');

    // The whole budget: three short lines of body plus the one instruction.
    const bodyLines = body.split('\n\n').slice(1).join('\n').split('\n').filter(Boolean);
    ok(bodyLines.length === 4, `the degraded body stays within four lines (got ${bodyLines.length})`);
  }

  // ============================================================================================
  console.log('\n2c. NEITHER FIGURE - a notice missing both numbers prints no bare rupee line');
  // ============================================================================================
  {
    // A payload that lost its numbers must omit them rather than print a bare rupee sign; a desk
    // notice never invents a figure to complete a sentence.
    const bare = renderMessage('desk_notice', toNotification(
      unreachableEvent({ standingBidPrice: null, correctedCost: null })).data);
    ok(!/₹\s*(\n|$)/.test(bare) && !/₹-/.test(bare), 'a notice missing its numbers prints no empty rupee line');
    ok(!/undefined|NaN/i.test(bare), 'and no undefined/NaN either');
    ok(/📌 \*New rate saved\. Bidding stopped on this load\.\*/.test(bare),
      'and it still says the true thing in the headline');
    ok(/Your new rate is not below our bid already on the board/.test(bare),
      'the reason line never depends on a figure, so it survives here too');
  }

  // ============================================================================================
  console.log('\n2d. THE HOLD IS THE MARGIN\'S DOING - corrected rate BELOW the standing bid');
  // ============================================================================================
  {
    // Load 260916V9D7, from the live record on the box: standingBidPrice 54500, correctedCost 53500,
    // floor 55426 (53,500 at the 3.6% minimum). The corrected rate IS below the board bid, so the
    // hold is not the rate failing to undercut us - it is the margin on top of it clearing 54,500.
    //
    // This shape shipped on 2026-09-16 rendering "*₹-1,000* under your rate if we win it" beneath a
    // sentence that was false as displayed. `corrected - standing` subtracts a COST from a BID; on
    // this load those are the wrong two numbers and the negative is the tell, not a display glitch.
    const body = renderMessage('desk_notice', toNotification(unreachableEvent({
      auctionId: '260916V9D7', standingBidPrice: 54500, correctedCost: 53500, floor: 55426,
      opening: 58315, price: 58315, reachAt: 54499,
    })).data);

    ok(!/₹-/.test(body) && !/-₹/.test(body), 'no negative rupee figure reaches the desk, on any line');
    ok(!/under your rate if we win it/.test(body),
      'the under-your-rate line is DROPPED - our bid is above the corrected rate, so it has no subject');
    ok(!/Your new rate is not below our bid already on the board/.test(body),
      'and the sentence that claim rests on is gone - 53,500 IS below 54,500, so it was false as displayed');

    ok(/\*₹54,500\* is our bid on the board/.test(body), 'the board bid still leads with its figure');
    ok(/\*₹53,500\* is your corrected rate/.test(body), 'so does the corrected rate, in its own slot');
    ok(/\*₹55,426\* is the lowest we can bid with margin added/.test(body),
      'and the figure that actually decided the hold is named: the rate with margin on it');
    ok(/With margin added, your new rate cannot go below our bid already on the board, so we cannot bid it\./.test(body),
      'the reason says what really happened, in plain words');
    ok(/Nothing further goes out on this load\./.test(body), 'and the consequence is unchanged');

    // The same G10 vocabulary bar the reachable body is held to - the new sentence may not smuggle
    // any of it back in.
    ok(!/\bband\b/i.test(body), 'never says "band"');
    ok(!/\bfloor\b/i.test(body), 'never says "floor"');
    ok(!/lowest price/i.test(body), 'never says "lowest price"');
    ok(!/%/.test(body), 'no percentages - margin is named, never quantified');
    ok(!/—/.test(body), 'no em dash');
    ok(!/undefined|NaN/i.test(body), 'never prints undefined or NaN');
  }

  // ============================================================================================
  console.log('\n2e. THE ROUTE LINE - city ends, not two postal addresses');
  // ============================================================================================
  {
    // 260916V9D7's real GoComet lane. The notice rendered both ends in full, which is the line the
    // desk asked about; the won/lost receipts already cut it through waTemplates.laneEnds, and this
    // notice must read as the same product rather than a third rendering of one lane.
    const evt = unreachableEvent({
      auctionId: '260916V9D7',
      lane: {
        origin: '3C/1, Ecotech-II, Udyog Vihar, Greater Noida, Gautam Buddha Nagar, Uttar Pradesh',
        destination: 'JAIN ENGINEERS TRADELINKS - 2327-1 E, Sudama Nagar, Indore - 452009',
      },
      laneCells: { from: 'Greater Noida 201306', to: 'Indore 452009' },
    });
    let seen = null;
    await notifyEngineEvent({ alert: async (kind, data) => { seen = { kind, data }; } },
      evt, null, null, 'gocomet');
    ok(!!seen && seen.kind === 'desk_notice', 'the notice still routes as a desk notice');
    const body = renderMessage('desk_notice', seen.data);
    ok(/📍 Greater Noida 201306 -> Indore 452009/.test(body),
      'the route line carries the two lane ends the receipts use, not the postal addresses');
    ok(!/Ecotech-II|Udyog Vihar|Sudama Nagar|JAIN ENGINEERS/.test(body),
      'and none of the street address survives onto the line');

    // No cells on the record (an auction armed before they were carried) - the ends are re-resolved
    // rather than the line falling back to the addresses it is supposed to replace.
    let seen2 = null;
    await notifyEngineEvent({ alert: async (kind, data) => { seen2 = { kind, data }; } },
      unreachableEvent({ lane: evt.lane }), null, null, 'gocomet');
    const body2 = renderMessage('desk_notice', seen2.data);
    ok(!/Ecotech-II, Udyog Vihar, Greater Noida, Gautam Buddha Nagar/.test(body2),
      'the fallback still bounds the origin rather than printing the whole address');
    ok(/-> Indore 452009/.test(body2), 'and the readable end still resolves to its city and pin');
  }

  // ============================================================================================
  console.log('\n2f. THE ROUTE LINE - a half-known lane never prints as a two-ended one');
  // ============================================================================================
  {
    // laneEnds keeps '?' for an end it cannot place and still welds on a separately recovered pin,
    // so an unplaced end arrives as '?' or '? 209304'. Both are truthy. The receipts' own sanitiser
    // drops them; this line must go through the same one rather than joining the raw values, or the
    // desk reads "? 209304 -> Indore 452009" - a pin that looks like a located origin on the one
    // message telling them a live auction was stood down.
    const route = (over) => {
      const n = toNotification(unreachableEvent());
      Object.assign(n.data, over);
      return renderMessage('desk_notice', n.data).split('\n').find((l) => l.startsWith('📍'));
    };

    const bare = route({ laneFrom: '?', laneTo: 'Indore 452009' });
    ok(bare === '📍 Indore 452009', 'a bare "?" origin drops out and the placed end renders alone');
    ok(!/->/.test(bare), 'no arrow, because there is no second end to point at');

    const pinned = route({ laneFrom: '? 209304', laneTo: 'Indore 452009' });
    ok(pinned === '📍 Indore 452009', 'an unplaced origin carrying a recovered pin drops out too');
    ok(!/209304/.test(pinned), 'the bare pin never renders - it reads as a located address');

    const toGone = route({ laneFrom: 'Greater Noida 201306', laneTo: '? 452009' });
    ok(toGone === '📍 Greater Noida 201306', 'and it degrades the same way on the destination end');

    ok(route({ laneFrom: 'Greater Noida 201306', laneTo: 'Indore 452009' })
      === '📍 Greater Noida 201306 -> Indore 452009', 'two placed ends still join with the arrow');
    ok(route({ laneFrom: '?', laneTo: '?' }) === '📍 Chikhli -> Hosur',
      'neither end placeable falls back to the lane string, as it did before the ends were threaded');

    // The same thing through the real producer: engineAlerts copies arm-time cells onto the payload
    // without filtering, so the placeholder reaches the template exactly as written here.
    let seen = null;
    await notifyEngineEvent({ alert: async (kind, data) => { seen = { kind, data }; } },
      unreachableEvent({
        lane: { origin: '3C/1, Ecotech-II, Udyog Vihar, Gautam Buddha Nagar', destination: 'Indore - 452009' },
        laneCells: { from: '? 209304', to: 'Indore 452009' },
      }), null, null, 'gocomet');
    ok(seen && seen.data.laneFrom === '? 209304', 'the producer does pass the placeholder through');
    const live = renderMessage('desk_notice', seen.data);
    ok(/📍 Indore 452009$/m.test(live), 'and the desk still sees one placed end, not a false origin');
    ok(!/209304 ->/.test(live), 'never a pin on the left of the arrow');
  }

  // ============================================================================================
  console.log('\n2b. THE CEILING NOTICE - rupee exposure (cost, ceiling, the gap)');
  // ============================================================================================
  {
    const body = renderMessage('desk_notice', toNotification(ceilingBelowFloorEvent()).data);
    ok(/Customer will not pay above\* - ₹30,000/.test(body), 'names the ceiling');
    ok(/Our cost\* - ₹32,700/.test(body), 'names the entered cost, not just the derived floor');
    ok(/₹2,700 above that/.test(body), 'and the real rupee gap - 32,700 minus the 30,000 ceiling');
    ok(/Our lowest price on this load\* - ₹30,540/.test(body), 'keeps the existing floor line too');

    // Cost fits (25,000 <= 30,000 ceiling); the FLOOR is what refused the load, not the cost. Naming
    // a cost-vs-ceiling gap here would be false - see ceilingCopy/noBidWhy for the same warning on
    // the sibling page and receipt copy - so the cost line must be left out rather than mislead.
    const marginCase = renderMessage('desk_notice', toNotification(
      ceilingBelowFloorEvent({ cost: 25000 })).data);
    ok(!/Our cost/.test(marginCase), 'cost that fits under the ceiling is not named as if it were the problem');
    ok(/Customer will not pay above\* - ₹30,000/.test(marginCase), 'the ceiling still renders');

    // A payload with no cost figure at all (an older event) must not crash or print a bare line.
    const noCost = renderMessage('desk_notice', toNotification(
      ceilingBelowFloorEvent({ cost: null })).data);
    ok(!/Our cost/.test(noCost), 'a notice with no cost figure omits the line rather than printing one empty');
  }

  // ============================================================================================
  console.log('\n3. THE CONFIRMATION - a save that will not bid is not acknowledged as one that will');
  // ============================================================================================
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const armedMonitor = (id) => {
    for (const s of stacks) { const m = s.engine && s.engine.monitors ? s.engine.monitors.get(id) : null; if (m) return m; }
    return null;
  };

  // Spy on the RENDERED receipt, not on the call: the defect is a message that promised bids the
  // engine would refuse, and only the rendered body can show whether that promise is still in it.
  const receipts = [];
  const realConfirm = notifier.confirmSubmitted.bind(notifier);
  notifier.confirmSubmitted = async (request, ladder, opts) => {
    receipts.push({
      loadId: request && request.loadId,
      opts,
      // waTemplates.biddingContract renders "We'll bid from X, never below Y" only from a ladder.
      promisesBids: Array.isArray(ladder) && ladder.length > 0,
    });
    return realConfirm(request, ladder, opts);
  };

  try {
    const r = await requests.createForLoad(loadWithCeiling('R-DEADREPRICE'));
    const first = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: LIVE_COST }) });
    ok(first.status < 400, `armed on a good cost (got ${first.status})`);
    ok(receipts.length === 1, 'the first capture is acknowledged, as it always was');

    // The desk pushes a dead band through with the acknowledgement. The save succeeds and the
    // engine will refuse every rung of it.
    const dead = await req('POST', `${base}/price/${r.id}`, {
      body: form({ cost: DEAD_COST, use_override: '1', m_0: '12', m_1: '7', m_2: '2', ceiling_ack: '1' }),
    });
    ok(dead.status < 400, `the acknowledged re-price is accepted (got ${dead.status})`);
    // Matched on the whole saved-message sentence, not on a fragment: the ceiling warning block is
    // static copy on this page and "nothing will be bid" appears in it whatever the save did.
    ok(/Saved\. Nothing will be bid - max bid here is Rs 26,000/.test(dead.text),
      'the page tells the truth: nothing will be bid');
    ok(!/Saved - bidding off the new cost/.test(dead.text), 'and it does not also claim bidding started');
    // The receipt is still SENT - withholding it would be a silence, see below - but the promise is
    // gone. A ceiling-dead re-arm still returns a full band ladder, so this only holds because the
    // ladder is dropped deliberately rather than by the plan happening to be empty.
    ok(receipts.length === 2, `the desk is still acknowledged for a dead re-price (got ${receipts.length - 1})`);
    ok(receipts[1].promisesBids === false,
      'but the receipt carries no "We\'ll bid from X, never below Y" promise the engine will refuse');

    // The ordinary re-price is untouched: a corrected rate that CAN be bid is still acknowledged
    // AND still carries its bidding contract - BRL's ask of 2026-07-16, which this must not withdraw.
    const alive = await req('POST', `${base}/price/${r.id}`, {
      body: form({ cost: '21000', use_override: '1', m_0: '12', m_1: '7', m_2: '2' }),
    });
    ok(alive.status < 400, `a live re-price is accepted (got ${alive.status})`);
    ok(/Saved - bidding off the new cost and margins now\./.test(alive.text),
      'and it still confirms that bidding is on the new cost');
    ok(receipts.length === 3, 'and it still sends the desk its receipt');
    ok(receipts[2].promisesBids === true, 'with the bidding contract intact, because this one really will bid');
    ok(receipts[2].opts && receipts[2].opts.reprice === true, 'flagged as a re-price receipt, not a first capture');

    // THE SILENCE THIS SHAPE EXISTS TO AVOID. Withholding the receipt outright looked right until
    // the second dead save: the engine's ceiling_below_floor notice keys on
    // `<load>_notice_ceiling_below_floor` with no epoch token and notifSent is permanent, so it is
    // delivered once per load for ever and cannot stand in for a withheld receipt. On this exact
    // sequence - dead, live, dead - the group's last word would have been "we are bidding".
    const deadAgain = await req('POST', `${base}/price/${r.id}`, {
      body: form({ cost: DEAD_COST, use_override: '1', m_0: '12', m_1: '7', m_2: '2', ceiling_ack: '1' }),
    });
    ok(deadAgain.status < 400, `a SECOND dead re-price is accepted (got ${deadAgain.status})`);
    ok(receipts.length === 4, 'and the desk hears about it - going quiet after a live bid would be the worse defect');
    ok(receipts[3].promisesBids === false, 'again with no bidding promise on it');
    ok(armedMonitor('R-DEADREPRICE') != null, 'and the load is still armed throughout');

    // The FIRST-CAPTURE branch of the same route. It sends its own receipt, so without the same
    // ladder drop one route would promise bids on an acknowledged-dead cost and the other would not.
    const c = await requests.createForLoad(loadWithCeiling('R-DEADCAPTURE'));
    const before = receipts.length;
    const res = await req('POST', `${base}/price/${c.id}`, {
      body: form({ cost: DEAD_COST, ceiling_ack: '1' }),
    });
    ok(res.status < 400, `a first capture pushed through dead is accepted (got ${res.status})`);
    ok(receipts.length === before + 1, 'the desk is acknowledged');
    ok(receipts[before].promisesBids === false,
      'and the first-capture receipt makes no bidding promise either - the two branches tell one story');

    // ==========================================================================================
    // 3b. THE JSON PATH - the AJAX submit the desk's browser actually runs (submitJson/showToast
    // in the inline client script), not just the non-JS full-page-reload fallback above. This is
    // the surface the UX review's screenshots caught still showing the false toast: the wantsJson
    // branch used to return before savedMsg was computed, so the client fell back to composing its
    // own "Saved - bidding..." string regardless of outcome.
    // ==========================================================================================
    const j = await requests.createForLoad(loadWithCeiling('R-JSONDEAD'));
    const jCapture = await req('POST', `${base}/price/${j.id}`, {
      body: JSON.stringify({ cost: LIVE_COST }), contentType: 'application/json',
    });
    ok(jCapture.status < 400, `JSON capture on a good cost is accepted (got ${jCapture.status})`);

    const jDead = await req('POST', `${base}/price/${j.id}`, {
      body: JSON.stringify({ cost: DEAD_COST, m_0: '12', m_1: '7', m_2: '2', ceiling_ack: '1' }),
      contentType: 'application/json',
    });
    const jDeadBody = JSON.parse(jDead.text);
    ok(jDeadBody.ok === true, `JSON dead re-price still saves (got status ${jDead.status})`);
    ok(/Nothing will be bid/.test(jDeadBody.savedMsg || ''),
      `JSON response savedMsg tells the true outcome (got: ${jDeadBody.savedMsg})`);
    ok(!/bidding off the new cost/.test(jDeadBody.savedMsg || ''),
      'and the JSON response never carries the false "bidding off the new cost" claim');
    ok(jDeadBody.savedIsError === true, 'and is flagged so the client does not paint it as a success toast');

    const jLive = await req('POST', `${base}/price/${j.id}`, {
      body: JSON.stringify({ cost: '21000', m_0: '12', m_1: '7', m_2: '2' }),
      contentType: 'application/json',
    });
    const jLiveBody = JSON.parse(jLive.text);
    ok(jLiveBody.ok === true, `JSON live re-price is accepted (got status ${jLive.status})`);
    ok(/Saved - bidding off the new cost and margins now\./.test(jLiveBody.savedMsg || ''),
      `a genuinely armed JSON re-price still claims bidding (got: ${jLiveBody.savedMsg})`);
    ok(!jLiveBody.savedIsError, 'and is not flagged as an error');
  } finally {
    notifier.confirmSubmitted = realConfirm;
    server.close();
  }

  console.log(`\nreprice-refusal-notice: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error('reprice-refusal-notice: FATAL', e); process.exitCode = 1; });
