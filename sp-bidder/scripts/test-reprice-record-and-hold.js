'use strict';
/**
 * AN UPWARD CORRECTION IS A FACT TO RECORD, NOT AN ERROR TO REJECT.
 *
 * Two different things are being refused when the desk corrects a cost upward mid-auction, and only
 * one of them is impossible. The corrected BID cannot go on the wire - a reverse auction takes only
 * a price below our own last one, measured 14 refusals in 14 attempts on load 260908LD2Z. The
 * corrected COST as a recorded fact has no such problem, and until this change we threw it away
 * with it: the reachability gate threw before patchDoc, so no cost, no audit row, no trace, and the
 * live monitor carried on descending on the number the desk had just told us was wrong.
 *
 * So all three re-price routes now take the held path automatically. They write the correction,
 * rebuild the ladder, and let the engine's own _holdAboveStandingBid stand the load down at
 * _decide, before the wire, where a held load spends no revision attempt.
 *
 * THE HOLD IS NOT status 'stopped', and that is asserted here rather than described. setBidOverride
 * refuses on 'stopped' (priceRequests.js NOT_OPEN), so a hold that used the status field would give
 * the desk exactly one correction per load and then freeze the record - the same class of bug as
 * the one being fixed.
 *
 * This file boots the real server because the inputs come from server helpers (standingBidFor,
 * armedFloorFor, standingBidHeld) that no in-process test reaches: test-reprice-standing-bid.js
 * hands setBidOverride a hand-built standingBid, which exercises the arithmetic while skipping the
 * wiring that computes it.
 *
 *   node scripts/test-reprice-record-and-hold.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';        // this file is about the hold, not close-scope
process.env.SP_NOTIFY_MODE = 'dashboard';    // no WhatsApp send in a unit test
process.env.SP_MIN_PLAUSIBLE_COST = '1';     // the low-cost guard is a different gate
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '0';
// Pin the band so every number here is exact: cost 29,000 -> [31610, 30450, 29290].
process.env.SP_MARGINS_PCT = '9,5,1';
process.env.SP_MIN_MARGIN_PCT = '1';
delete process.env.SP_ADMIN_PASS_HASH;       // auth off - this is about the hold, not the login gate
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-record-hold-'));

const http = require('http');
const { app, requests, stacks, store } = require('../src/web/server');
const { resolveBidTimeCost } = require('../src/notify/bidTimeCost');
const { outcomeEnrichment } = require('../src/notify/engineAlerts');

let pass = 0, fail = 0;
const EXPECTED_CHECKS = 128;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

function req(method, url, { body = null, contentType = null, origin = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType || 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    // The /api surface refuses a cross-site POST outright, so an API call carries the same-origin
    // header a browser would send. The public /price form post does not.
    if (origin) headers.origin = origin;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

const COST = 29_000;
const STANDING = 31_610;              // ladder[0] on the pinned band - what the load has on the portal
const NEW_COST = 38_000;              // the correction: every rung of its band is above STANDING
const GAP = NEW_COST - STANDING;      // 6,390 - what the load comes in under, if it is won
const NEW_BAND = { marginsPct: [9, 7.2, 1.8], minMarginPct: 1.8 };

const armedMonitor = (loadId) => {
  for (const s of stacks) {
    const m = s.engine && s.engine.monitors ? s.engine.monitors.get(loadId) : null;
    if (m) return m;
  }
  return null;
};
const engineFor = (id) => {
  for (const s of stacks) if (s.engine && s.engine.monitors && s.engine.monitors.get(id)) return s.engine;
  return null;
};
// The margin audit is an append-only event stream, so a route that writes one is proven by a row
// naming THIS load appearing where there was none - not by the row count moving.
const auditRowsFor = async (loadId, action) => {
  const rows = await store.readEvents('configChanges');
  return (rows || []).filter((e) => e && e.action === action
    && Array.isArray(e.changed) && e.changed.some((c) => String(c).includes(String(loadId))));
};
// Everything the desk can actually read: the inline script is a string literal on every render, so
// matching page source would match copy the desk never sees.
const visibleBody = (html) => String(html).replace(/<script[\s\S]*?<\/script>/gi, '');
// The strip, split where the desk's tap splits it. AT REST only `summary` is on screen; `body` costs
// one tap. Testing the two halves separately is the only way a source-string assertion can tell the
// resting state from the open one, since a closed <details> still ships its body in the markup.
//
// The opening tag is dropped from both halves on purpose: it carries the after-close wording in
// data- attributes, which quotes both rupee figures, and a negative assertion that read it would
// pass or fail on copy that is not on screen in either state.
const strip = (html) => {
  const m = String(html).match(/<details class="hstrip"[\s\S]*?<\/details>/);
  if (!m) return { found: false, summary: '', body: '', openTag: '' };
  const all = m[0];
  const tagEnd = all.indexOf('>');
  const cut = all.indexOf('</summary>');
  return { found: true, openTag: all.slice(0, tagEnd + 1), summary: all.slice(tagEnd + 1, cut), body: all.slice(cut) };
};

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now();
  const mkLoad = (id) => ({
    id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
    quoteType: 'FTL', companyName: 'Waaree Energies', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
    softClose: false, closeModelKnown: true, status: 'live',
  });
  const margin = (id, body) => req('POST', `${base}/api/price-requests/${id}/margin`, { body: JSON.stringify(body), origin: base });
  const clearMargin = (id, body) => req('POST', `${base}/api/price-requests/${id}/margin/clear`, { body: JSON.stringify(body), origin: base });
  const priceForm = (id, body) => req('POST', `${base}/price/${id}`,
    { body: form(body), contentType: 'application/x-www-form-urlencoded' });

  // Arm a load, then put a bid on its board the way a landed bid really leaves things: on the live
  // monitor AND on the durable intent.
  //
  // The intent half is load-bearing, not tidiness. reArmWithNewBand is stop() + armFromRequest, and
  // arm() rebuilds the successor's lastBidPrice/landedBids from the INTENT - so a fixture that
  // seeds only the monitor produces a successor with landedBids 0, whose _mustImproveOn returns
  // null and whose stand-down belt is therefore disarmed. This file's whole safety claim is that
  // the write is recorded and the ENGINE still refuses the bid; seeding one half would let that
  // claim pass against an engine that had stopped refusing anything.
  const armedWithStandingBid = async (id, standing = STANDING) => {
    const r = await requests.createForLoad(mkLoad(id));
    const res = await priceForm(r.id, { cost: String(COST) });
    if (res.status !== 200) throw new Error(`setup failed to arm ${id}: HTTP ${res.status}`);
    const m = armedMonitor(id);
    if (!m) throw new Error(`setup failed: no live monitor for ${id}`);
    m.lastBidPrice = standing;
    m.landedBids = 1;
    for (const s of stacks) {
      if (s.engine && s.engine.scheduler && s.engine.scheduler.get(id)) {
        s.engine.scheduler.update(id, { landedBids: 1, landedBidPrice: standing, everBid: true });
      }
    }
    return r;
  };

  console.log('\n1. the console margin route records the correction instead of refusing it');
  {
    const r = await armedWithStandingBid('REC-1');
    const before = await auditRowsFor('REC-1', 'margin_override_set');
    const res = await margin(r.id, { ...NEW_BAND, cost: NEW_COST, confirm: true });
    ok(res.status === 200, `the unreachable correction is ACCEPTED, not 409'd (got ${res.status})`);
    const after = await requests.getByToken(r.id);
    ok(after.price.cost === NEW_COST,
      'and the corrected cost IS on the load - the half the portal has no opinion about');
    ok((await auditRowsFor('REC-1', 'margin_override_set')).length === before.length + 1,
      'the margin_override_set audit row is written, so a post-mortem can see the desk stated a different cost');
    ok(after.status === 'armed',
      'the request status stays armed - a held load whose status went stopped could never be corrected again (CW-220)');
    ok(!!after.hold && after.hold.kind === 'standing',
      'the hold is recorded off the status field, on its own durable record');
    ok(after.hold.standingBidPrice === STANDING && after.hold.correctedCost === NEW_COST,
      'carrying the two figures the decision turns on');
    ok(!!res.json && !!res.json.held && res.json.held.correctedCost === NEW_COST,
      'and the route answers with the held response rather than an error body');
  }

  console.log('\n2. so does the revert route, whose own band is what turns unreachable');
  {
    const r = await armedWithStandingBid('REC-2');
    const set = await margin(r.id, { ...NEW_BAND, cost: NEW_COST, confirm: true });
    if (set.status !== 200) throw new Error(`precondition: the correction should be accepted, got ${set.status}`);
    const before = await auditRowsFor('REC-2', 'margin_override_clear');

    // "Revert to standard margins" on a corrected cost RAISES the floor back to the inherited band's
    // - 38,000 at 1% is 38,380, still above the 31,610 standing. Nobody typed a number, which is
    // what makes this the cause most likely to surprise the desk.
    const res = await clearMargin(r.id, { confirm: true });
    ok(res.status === 200, `the revert is ACCEPTED, not 409'd (got ${res.status})`);
    ok((await auditRowsFor('REC-2', 'margin_override_clear')).length === before.length + 1,
      'and its own audit row is written');
    const after = await requests.getByToken(r.id);
    ok(after.status === 'armed' && !!after.hold && after.hold.kind === 'standing',
      'the load is held, on the record and not on the status');
    ok(after.price.cost === NEW_COST, 'and the corrected cost survives the revert');
  }

  console.log('\n3. the desk page saves, holds, and says so in the words the redesign specifies');
  {
    const r = await armedWithStandingBid('REC-3');
    const res = await priceForm(r.id, { cost: String(NEW_COST), m_0: '9', m_1: '7.2', m_2: '1.8', use_override: '1' });
    ok(res.status === 200, `the desk's own correction is accepted (got ${res.status})`);
    const after = await requests.getByToken(r.id);
    ok(after.price.cost === NEW_COST && after.status === 'armed' && !!after.hold,
      'cost recorded, status still armed, hold on its own record');

    const v = visibleBody(res.text);
    const GAP_RS = `Rs ${GAP.toLocaleString('en-IN')}`;
    const s = strip(v);

    // AT REST. One line: the state, the one figure that is bad, and a chevron. Everything the page
    // below already says - the struck ladder, the ON RECORD pill, the demoted Re-price button -
    // carries the rest, so the strip does not repeat it.
    ok(s.found && !/\bopen\b/.test(s.openTag),
      'the held state is a strip, and it lands closed - the desk sees one line, not a panel');
    ok(/On hold/.test(s.summary), 'the resting line leads with a status pill');
    ok(s.summary.includes(GAP_RS) && /under your rate/.test(s.summary),
      'and states the gap, which is the only genuinely bad number on the page');
    ok(s.found && !s.summary.includes('Rs 31,610') && !/our bid on the board|your rate, now on record/.test(s.summary),
      'the ledger is NOT on the resting line - three figures are not what a settled screen needs at a glance');
    ok(s.found && !/uses up attempts|reverse auctions/.test(s.summary),
      'and neither is the portal warning or the physics - a settled state gets a status, not an essay');

    // ONE TAP, in the 03e compact shape: two figures, one sentence, and the way out. Nothing else.
    ok(/Rs 31,610<\/span><span class="llab">our bid on the board/.test(s.body)
      && /Rs 38,000<\/span><span class="llab">your rate, saved/.test(s.body),
      'the ledger leads, figure first and label after - two rates, in that order');
    ok(/Bidding stopped\. Lower the cost to bid again\./.test(s.body),
      'then one sentence: the load is paused, and the safe way out of it');
    ok(/Resume bidding at Rs 29,000/.test(s.body),
      'and the named action, carrying its figure - reverting to that cost IS what un-pauses the ladder');
    ok(!/Saved\. We have stopped bidding this load\./.test(s.body)
      && !/under your rate if we win this load/.test(s.body)
      && !/Why can't Rs 38,000 be bid\?/.test(s.body),
      'the 03d headline, gap subtotal and physics prose are gone - the expanded state is three lines, not an essay');

    // THE CONFIRM, which replaces the expanded body rather than adding to it - so the second tap
    // never grows the panel.
    ok(/id="confirmState" hidden/.test(s.body), 'the resume confirm ships hidden, behind the first tap');
    ok(/Rs 29,000<\/span><span class="llab">replaces your Rs 38,000/.test(s.body)
      && /Rs 31,610<\/span><span class="llab">we keep bidding down from here/.test(s.body),
      'and states both consequences: the correction is discarded, and the next bid is BELOW the standing bid');
    ok(/id="doResume">Resume bidding</.test(s.body) && /id="cancelResume">Keep on hold</.test(s.body),
      'with both ways out of the confirm');

    // THE PORTAL WARNING, relocated. It is not in the panel any more; it is on the struck ladder box
    // it is about, which is where the operator is looking when they reach for the portal.
    ok(/Do not change this on the portal by hand\./.test(v)
      && /It will not lower the bid and it uses up attempts\./.test(v),
      'the one instruction that cost 2 of 3 revision attempts when it was missing is still on the page, BOTH claims');
    ok(!/Do not change this on the portal by hand\./.test(s.body),
      'and it is NOT inside the panel - a tap the operator has no reason to make is not where that sentence goes');
    ok(/<div id="dontSlot"><div class="dontb"/.test(v),
      'it sits on the ladder box below the panel, the placement 03d-concept-b drew');

    // The G6 fixes. Each of these is the page contradicting the panel on the same screen.
    ok(/On hold - not being sent/.test(v), 'the price preview is relabelled to what it now is');
    ok(/class="brange dead"/.test(v), 'and its figures are struck through rather than shown live');
    ok(!/Already priced - bidding is active/.test(v),
      'the "bidding is active" block is gone - both halves of it are false on a held load');
    ok(!/to leave time to place it/.test(v),
      'and so is the cutoff line, which promises a placement that will not happen');
    ok(!/bidding off the new/.test(v),
      'nothing on the page claims bidding resumed - the sentence this workstream exists to remove');
    ok(!/class="flash ok-flash"/.test(v), 'and the green success flash is suppressed');
    ok(/On record/.test(v), 'the cost field carries the ON RECORD pill, which is the save confirmed');

    // STICKY. The strip is page furniture read back off the durable hold record, not a bubble the
    // POST produced - so a reload lands on the same one line, still closed.
    const reload = await req('GET', `${base}/price/${r.id}`);
    const rs = strip(visibleBody(reload.text));
    ok(reload.status === 200 && rs.found && !/\bopen\b/.test(rs.openTag),
      'a reload shows the same strip, at rest - the state is durable, not a toast that expired');
    ok(rs.summary.includes(GAP_RS) && /On hold/.test(rs.summary)
      && /Resume bidding at Rs 29,000/.test(rs.body),
      'carrying the same resting line and the same way out behind it');
    ok(/It will not lower the bid and it uses up attempts\./.test(visibleBody(reload.text)),
      'and the portal warning survives the reload on its own element, not as panel copy');

    // Quoted verbatim into the WhatsApp notice and the JSON client, so the three cannot disagree.
    const jsonRes = await req('POST', `${base}/price/${r.id}`,
      { body: JSON.stringify({ cost: NEW_COST, m_0: '9', m_1: '7.2', m_2: '1.8', use_override: '1' }) });
    ok(jsonRes.status === 200 && !!jsonRes.json.held && typeof jsonRes.json.held.panel === 'string',
      'the AJAX submit gets the same panel, built server-side, not a toast');
    // The held-response CONTRACT, pinned by shape. The console and the AJAX client both read this,
    // and the redesign moved only what the panel string renders - a key added or dropped here would
    // be a change to the other two surfaces, which this pass is not allowed to make.
    const heldKeys = Object.keys(jsonRes.json.held);
    ok(['correctedCost', 'gap', 'panel', 'reason', 'standingBidPrice'].every((k) => heldKeys.includes(k))
      && jsonRes.json.held.reason === 'new_floor_above_standing_bid'
      && jsonRes.json.held.standingBidPrice === STANDING
      && jsonRes.json.held.correctedCost === NEW_COST
      && jsonRes.json.held.gap === GAP,
      'and the held response still carries all five keys it always did, with the same values - the contract may grow, never shrink');
    ok(jsonRes.json.held.resumeCost === COST && typeof jsonRes.json.held.portalWarning === 'string',
      'plus the two additive keys the redesign needs: the cost a resume restores, and the relocated warning');

    // ------------------------------------------------------------------------------------------
    // THE MARGIN-DRIVEN HOLD, which every assertion above this point misses: each one is priced
    // ABOVE the standing bid, so `corrected - standing` came out positive and the arithmetic was
    // never exercised in the direction that breaks it.
    //
    // Load 260916V9D7's real figures. 53,500 is genuinely below the 54,500 on the board; what
    // clears it is the 3.6% minimum on top (55,426). The strip printed "Rs -1,000 under your rate"
    // on this shape, which is the same inverted subtraction the WhatsApp notice shipped.
    // ------------------------------------------------------------------------------------------
    {
      const B_STANDING = 54_500;
      const B_COST = 53_500;
      const B_FLOOR = 55_426;              // B_COST at the 3.6% minimum - what actually cleared the board bid
      const rb = await armedWithStandingBid('REC-3B', B_STANDING);
      const setB = await margin(rb.id,
        { marginsPct: [9, 7.2, 3.6], minMarginPct: 3.6, cost: B_COST, confirm: true });
      ok(setB.status === 200, `the below-bid correction is accepted and held (got ${setB.status})`);
      const heldB = setB.json && setB.json.held;
      ok(!!heldB && heldB.standingBidPrice === B_STANDING && heldB.correctedCost === B_COST,
        'the hold records both figures the way the live record carries them');
      ok(!!heldB && heldB.floor === B_FLOOR,
        `the rate-with-margin is on the held response, since it is what decided this hold (got ${heldB && heldB.floor})`);
      ok(!!heldB && heldB.gap === null,
        `gap is null, not a negative - our bid is ABOVE their rate, so there is no under-gap to state (got ${heldB && heldB.gap})`);

      const sb = strip(visibleBody((await req('GET', `${base}/price/${rb.id}`)).text));
      ok(sb.found, 'the held strip renders on this shape too');
      ok(!/Rs -/.test(sb.summary) && !/Rs -/.test(sb.body),
        'and no negative rupee figure is anywhere on the strip, at rest or expanded');
      ok(!/under your rate/.test(sb.summary),
        'the resting line drops the under-your-rate label, which is false on this load');
      ok(/Rs 55,426/.test(sb.summary) && /lowest we can bid with margin/.test(sb.summary),
        'and states the figure that actually decided it instead');
      ok(/Rs 55,426<\/span><span class="llab">lowest we can bid with margin/.test(sb.body),
        'the expanded ledger carries it as a third row, below the two the desk already had');
      ok(/Rs 54,500<\/span><span class="llab">our bid on the board/.test(sb.body)
        && /Rs 53,500<\/span><span class="llab">your rate, saved/.test(sb.body),
        'with the first two rows unchanged, in the same order');
      ok(!/\bband\b|\bfloor\b|lowest price|%/i.test(sb.summary + sb.body),
        'and the new row clears the same vocabulary bar as the rest of this copy');
    }

    // Carried over from #219's F19 repair. Off the hold path the browser still has to render the
    // SERVER's verdict rather than composing one: the ceiling-dead save comes back through this
    // same toast, and a client that words its own can disagree with the page about one load.
    ok(/showToast\(r\.data\.savedMsg\|\|'Saved\.',!!r\.data\.savedIsError,!!r\.data\.savedSticky\)/.test(res.text),
      'the shipped client renders the server\'s message, error flag and stickiness');
    ok(!/describeChange|Reverted to standard margins\.',false/.test(res.text),
      'and no locally-composed message or revert short-circuit survives in the shipped script');
  }

  console.log('\n3b. the two shapes where the gap is negative WITHOUT anyone typing a low rate');
  {
    // Section 3's REC-3B pins the desk-typed correction below the standing bid. Two further paths
    // reach the same sign without the desk typing anything unusual, and neither was exercised: a
    // REVERT, and a floor the gate could not work out at all. Both rendered "under your rate" over
    // a negative on the shipped code.

    // ---- THE REVERT, where the sign is negative BY CONSTRUCTION -------------------------------
    // A revert types no new cost. correctedCost is therefore the cost already stored, while the
    // standing bid is a markup derived from that same cost - so corrected is below standing
    // whenever margins are positive, which #238 now guarantees they always are. Section 2 only
    // ever reverts a load whose cost was first RAISED to 38,000, which hides this entirely.
    {
      const C = COST;                    // 29,000 - stored at arm and never retyped
      const S = 29_200;                  // a markup off that same cost, and what sits on the board
      const REVERTED_FLOOR = 29_290;     // C at the inherited 1% minimum - what the revert restores
      const r = await armedWithStandingBid('REC-3C', S);
      // Put the load somewhere reachable first, so the REVERT is what turns it unreachable rather
      // than the load having been held all along.
      const live = await margin(r.id,
        { marginsPct: [9, 5, 0.6], minMarginPct: 0.6, cost: C, confirm: true, below_min_ack: '1' });
      ok(live.status === 200 && !live.json.held,
        `precondition: the override leaves the load biddable, not held (got ${live.status})`);

      const rev = await clearMargin(r.id, { confirm: true });
      ok(rev.status === 200, `the revert is accepted (got ${rev.status})`);
      const held = rev.json && rev.json.held;
      ok(!!held, 'and the reverted band is what holds the load');
      ok(!!held && held.correctedCost === C && held.standingBidPrice === S,
        `precondition: corrected IS below standing here, with no cost typed (${held && held.correctedCost} vs ${held && held.standingBidPrice})`);
      ok(!!held && held.floor === REVERTED_FLOOR,
        `the restored band's rate-with-margin is on the response (got ${held && held.floor})`);
      ok(!!held && held.gap === null,
        `gap is null on the revert path, where the raw subtraction is negative by construction (got ${held && held.gap})`);

      const sv = strip(visibleBody((await req('GET', `${base}/price/${r.id}`)).text));
      ok(sv.found && !/Rs -/.test(sv.summary) && !/Rs -/.test(sv.body),
        'and no negative rupee figure renders anywhere on the reverted load\'s strip');
      ok(!/under your rate/.test(sv.summary),
        'the resting line does not claim our bid is under their rate - on a revert it never is');
      ok(/Rs 29,290/.test(sv.summary) && /lowest we can bid with margin/.test(sv.summary),
        'it states the restored rate-with-margin instead, which is what actually blocked the bid');
    }

    // ---- THE FLOOR THE GATE COULD NOT WORK OUT -----------------------------------------------
    // standingBidHeld fails CLOSED with reason 'floor_not_computable' and floor null (server.js).
    // Nothing constrains the two operands on that path, so the subtraction is unbounded - the
    // shipped code rendered "Rs -48,000 under your rate" on this exact shape. With no floor there
    // is no honest third figure either, so the resting line must carry NO figure rather than a
    // wrong one: a settled screen that shows one number must not show a number that is false.
    {
      const r = await armedWithStandingBid('REC-3D');
      await requests.holdBidding(r.id, {
        kind: 'standing', reason: 'floor_not_computable',
        standingBidPrice: 78_000, correctedCost: 30_000, floor: null,
      });
      const sf = strip(visibleBody((await req('GET', `${base}/price/${r.id}`)).text));
      ok(sf.found, 'the fail-closed hold still renders its strip');
      ok(!/Rs -/.test(sf.summary) && !/Rs -/.test(sf.body),
        'with no negative figure - the unbounded subtraction reached the desk as "Rs -48,000" before');
      ok(!/under your rate/.test(sf.summary),
        'and no under-your-rate claim, which nothing on this path establishes');
      ok(/Rs 78,000<\/span><span class="llab">our bid on the board/.test(sf.body)
        && /Rs 30,000<\/span><span class="llab">your rate, saved/.test(sf.body),
        'the two figures it DOES know still render in the expanded ledger');
      ok(!/lowest we can bid with margin/.test(sf.body),
        'but no rate-with-margin row is invented, because this path never computed one');
    }
  }

  console.log('\n4. a held load can still be corrected again - the CW-220 freeze, not reproduced');
  {
    const r = await armedWithStandingBid('REC-4');
    const first = await priceForm(r.id, { cost: String(NEW_COST), m_0: '9', m_1: '7.2', m_2: '1.8', use_override: '1' });
    if (first.status !== 200) throw new Error(`precondition: the first correction should be accepted, got ${first.status}`);
    ok((await requests.getByToken(r.id)).status !== 'stopped',
      'the first correction did not stop the request, which is what would freeze the record');

    const second = await priceForm(r.id, { cost: '39000', m_0: '9', m_1: '7.2', m_2: '1.8', use_override: '1' });
    ok(second.status === 200, `a SECOND correction on the same held load is accepted (got ${second.status})`);
    const after = await requests.getByToken(r.id);
    ok(after.price.cost === 39_000, 'and it is the one on record - the desk gets more than one shot at the truth');
    ok(!!after.hold && after.hold.correctedCost === 39_000,
      'the hold record is rewritten to the new figures, so a stale panel cannot outlive the correction it described');
    ok(!!after.hold.resume && after.hold.resume.cost === COST,
      'but the RESUME target does not move to 38,000 - that cost was never biddable, and resuming to it would put an unbiddable plan back on a live auction');
    ok(Array.isArray(after.holdHistory) && after.holdHistory.length === 1
      && after.holdHistory[0].correctedCost === NEW_COST
      && after.holdHistory[0].resolvedReason === 'superseded_by_reprice',
      'and the hold the second correction replaced is kept, not overwritten - the record of a load that stopped bidding is the whole point of it');
  }

  console.log('\n5. the hold happens at the engine, before anything reaches the wire');
  {
    const m = armedMonitor('REC-3');
    const engine = engineFor('REC-3');
    ok(!!m && m.landedBids > 0,
      'the re-armed monitor still knows a bid is on the board (the belt is armed, not bypassed)');
    ok(!!engine && engine._mustImproveOn(m) === STANDING - 1,
      'so every rung is judged against the Rs 31,610 standing on the portal');
    ok(m.ladder.every((p) => p > STANDING - 1),
      'and the whole corrected ladder, floor included, sits above it - there is nothing legal left to send');

    const seen = [];
    const realEmit = engine.emit.bind(engine);
    engine.emit = (evt) => { seen.push(evt); return realEmit(evt); };
    try { engine._holdAboveStandingBid(m, m.ladder[m.ladder.length - 1], engine._mustImproveOn(m)); }
    finally { engine.emit = realEmit; }
    const alert = seen.find((e) => e && e.kind === 'reprice_unreachable_ladder');
    ok(!!alert, 'the stand-down raises reprice_unreachable_ladder');
    ok(!!alert && alert.correctedCost === NEW_COST,
      'carrying the desk\'s own corrected rate, which is the figure the notice has to name');
    ok(m._unreachableLadderAlerted === true, 'and latches once per load, so a re-decide cannot flood');
  }

  console.log('\n6. a floor the engine cannot work out still fails CLOSED, at submit');
  {
    // Carried over from #219's F12 repair, which survives this layer: nothing here is refused on
    // REACHABILITY any more, but a floor that could not be COMPUTED is a different fact, and
    // requireArmedFloor must still stop the write. Left to fall through it would save a band no
    // check ever saw and the hold detector would then be asked the same unanswerable question.
    const r = await armedWithStandingBid('REC-6');
    const saved = [];
    for (const s of stacks) {
      if (!s.engine || typeof s.engine.planPreview !== 'function') continue;
      saved.push([s.engine, s.engine.planPreview]);
      s.engine.planPreview = () => { throw new Error('_planFor produced a non-finite or non-positive floor'); };
    }
    ok(saved.length > 0, 'precondition: there is a planPreview to break');
    const res = await margin(r.id, { ...NEW_BAND, cost: NEW_COST, confirm: true });
    for (const [engine, fn] of saved) engine.planPreview = fn;

    ok(res.status === 400, 'the save is refused rather than written without a check');
    ok(!!(res.json && /could not be\s+worked out/.test(res.json.error || '')),
      'with a plain corrective message the desk can act on while acting is still cheap');
    const after = await requests.getByToken(r.id);
    ok(after.price.cost === COST, 'and nothing was written - the load keeps bidding the ladder it already has');
  }

  console.log('\n7. the compact panel is compact by construction, not by luck');
  {
    // The 181px expanded state and the 155px confirm are measured in a browser (the capture rig
    // prints both off getBoundingClientRect). What is asserted HERE is the thing that PRODUCES those
    // numbers and that a later edit could silently undo: an element budget. Every block 03d carried
    // and 03e cut is ~60-95px, so a regression is a block reappearing, and that is countable in a
    // test that needs no browser and cannot go flaky in CI.
    const r = await armedWithStandingBid('REC-7');
    const res = await priceForm(r.id, { cost: String(NEW_COST), m_0: '9', m_1: '7.2', m_2: '1.8', use_override: '1' });
    if (res.status !== 200) throw new Error(`precondition: the correction should be accepted, got ${res.status}`);
    const s = strip(visibleBody(res.text));
    const count = (re) => (s.body.match(re) || []).length;

    ok(count(/class="hbody"/g) === 2, 'the panel has exactly two bodies - the expanded state and the confirm that replaces it');
    ok(count(/class="lrow"/g) === 4, 'four ledger rows in total, two per body - never three figures in one state');
    ok(count(/class="hact"/g) === 1, 'one sentence of prose, and only in the expanded state');
    ok(count(/class="rbtn"/g) === 2 && count(/class="rlink"/g) === 1,
      'three controls across both states: the resume ask, the confirm, and the way back');
    ok(!/class="lsum"|class="dont"|class="whyw"/.test(s.body),
      'and none of the three blocks 03d carried - the subtotal, the warning and the physics are all out of the panel');
    // The confirm is a SIBLING of the expanded body, not a child of it. That is what makes the second
    // tap swap in place instead of growing the panel under the operator's thumb.
    ok(/id="holdState"[\s\S]*<\/div><div class="hbody" id="confirmState"/.test(s.body),
      'the confirm sits beside the expanded body, so it replaces it rather than opening under it');
  }

  console.log('\n8. resume restores the plan that priced the standing bid, and the ladder does the rest');
  {
    const r = await armedWithStandingBid('REC-8');
    const first = await priceForm(r.id, { cost: String(NEW_COST), m_0: '9', m_1: '7.2', m_2: '1.8', use_override: '1' });
    if (first.status !== 200) throw new Error(`precondition: the correction should be accepted, got ${first.status}`);
    const held = await requests.getByToken(r.id);
    ok(!!held.hold && held.hold.resume && held.hold.resume.cost === COST,
      'the hold carries the cost that priced the standing bid - without it there is nothing to resume TO');

    const res = await req('POST', `${base}/price/${r.id}/resume`, { body: '{}' });
    ok(res.status === 200 && !!res.json && res.json.ok === true && !res.json.held,
      `the resume is accepted and comes back NOT held (got ${res.status})`);
    const after = await requests.getByToken(r.id);
    ok(after.price.cost === COST, 'the pre-correction cost is back on the active plan');
    ok(!after.hold, 'the hold is closed, so a reload lands on the ordinary bidding page');
    ok(Array.isArray(after.holdHistory) && after.holdHistory.length === 1
      && after.holdHistory[0].resolvedReason === 'resumed_by_desk'
      && after.holdHistory[0].correctedCost === NEW_COST,
      'and the hold that ended is kept with its own reason, carrying the corrected cost that caused it');

    // The page a reload lands on. The held furniture has to be gone, all of it - a page still saying
    // "on hold - not being sent" over a load that is bidding is the same defect in the other direction.
    const reload = await req('GET', `${base}/price/${r.id}`);
    const v = visibleBody(reload.text);
    ok(reload.status === 200 && !strip(v).found, 'the strip is gone from the reloaded page');
    ok(!/On hold - not being sent/.test(v) && !/class="brange dead"/.test(v),
      'the ladder box is live again, not struck through');
    ok(!/It will not lower the bid and it uses up attempts\./.test(v),
      'and the portal warning goes with it - it is about a held ladder, and this one is not held');

    // THE ENGINE, which is the half that decides money. The restored ladder is [31610, 30450, 29290]
    // and our own 31,610 is standing, so the opening rung is refused and the ladder continues DOWN.
    const m = armedMonitor('REC-8');
    const engine = engineFor('REC-8');
    ok(!!m && m.landedBids > 0,
      'the re-armed monitor still knows a bid is on the board - a resume does not hand the load a fresh budget');
    ok(!!engine && engine._mustImproveOn(m) === STANDING - 1,
      'so the strictly-below-our-own-standing-bid rule is still what every rung is judged against');
    ok(m.ladder.some((p) => p <= STANDING - 1),
      'and the restored ladder HAS a rung below it - there is something legal left to send, which is the whole point of resuming');
    ok(m.ladder.every((p) => p >= m.floor),
      'the floor gate came back with the plan - no rung sits under the lowest price this cost allows');
    ok(m.ladder[m.ladder.length - 1] < NEW_COST,
      'and the ladder is the restored plan\'s, not the correction\'s - every rung is under the 38,000 that was withdrawn');
  }

  console.log('\n9. the reverse-auction invariants a resume must not break');
  {
    const m = armedMonitor('REC-8');
    const engine = engineFor('REC-8');
    // NEVER AT OR ABOVE OUR OWN STANDING BID. Asserted against the engine's own gate rather than by
    // reading the ladder, because the ladder is only the candidate set - the gate is what refuses.
    const reachAt = engine._mustImproveOn(m);
    ok(reachAt < STANDING, 'the improvement wall sits strictly below the standing bid, never at it');
    // The restored ladder DOES contain 31,610 - it is the same plan that produced the standing bid,
    // so its opening rung is the price already on the board. That is not the defect; sending it would
    // be. The gate is what makes the difference, so the gate is what is asserted.
    ok(m.ladder.includes(STANDING), 'the restored ladder still opens at the price already on the board - it is the same plan');
    ok(!m.ladder.filter((p) => p <= reachAt).includes(STANDING),
      'and that rung is outside what the engine will send - a resumed load never re-offers its own standing price');
    // THE FLOOR GATE. The restored band's operating floor is the lowest thing that can go out, and it
    // is the RESTORED one - a resume that inherited the correction's floor would bid a price the desk
    // had already withdrawn.
    ok(m.floor > 0 && m.floor < NEW_COST,
      'the operating floor is the restored plan\'s, not the 38,000 correction\'s - a resume that inherited the correction\'s floor would bid a price the desk withdrew');

    // A REFUSED PRICE IS NEVER RETRIED. The hold latch is the engine's, and a resume must not reach
    // in and clear it on a monitor that is still above the standing bid.
    const r2 = await armedWithStandingBid('REC-9');
    const corrected = await priceForm(r2.id, { cost: String(NEW_COST), m_0: '9', m_1: '7.2', m_2: '1.8', use_override: '1' });
    if (corrected.status !== 200) throw new Error(`precondition: the correction should be accepted, got ${corrected.status}`);
    const before = armedMonitor('REC-9');
    const beforeLanded = before ? before.landedBids : null;
    const resumed = await req('POST', `${base}/price/${r2.id}/resume`, { body: '{}' });
    ok(resumed.status === 200, `the resume lands (got ${resumed.status})`);
    const afterM = armedMonitor('REC-9');
    ok(!!afterM && afterM.landedBids === beforeLanded,
      'the budget already spent stays spent across the resume - the count is carried on the intent, not reset by it');
    ok(!afterM._unreachableLadderAlerted,
      'and the fresh monitor is not carrying the old one\'s stand-down latch, which would mute a genuine second hold');
  }

  console.log('\n10. resume refuses cleanly when there is nothing left to resume into');
  {
    // AFTER THE CLOSE. No bid, no crash, and - the part that matters - no write: the hold record has
    // to survive untouched, because the page the desk is looking at is rendered from it.
    const r = await requests.createForLoad(mkLoad('REC-10'));
    const armed = await priceForm(r.id, { cost: String(COST) });
    if (armed.status !== 200) throw new Error(`setup failed to arm REC-10: HTTP ${armed.status}`);
    const m = armedMonitor('REC-10');
    m.lastBidPrice = STANDING; m.landedBids = 1;
    for (const s of stacks) {
      if (s.engine && s.engine.scheduler && s.engine.scheduler.get('REC-10')) {
        s.engine.scheduler.update('REC-10', { landedBids: 1, landedBidPrice: STANDING, everBid: true });
      }
    }
    const corrected = await priceForm(r.id, { cost: String(NEW_COST), m_0: '9', m_1: '7.2', m_2: '1.8', use_override: '1' });
    if (corrected.status !== 200) throw new Error(`precondition: the correction should be accepted, got ${corrected.status}`);
    const beforeDoc = await requests.getByToken(r.id);
    // Close the auction under the held load, the way the portal does.
    await store.patchDoc('priceRequests', r.id,
      { load: Object.assign({}, beforeDoc.load, { closesAt: Date.now() - 1000, liveClosesAt: null }) });

    const res = await req('POST', `${base}/price/${r.id}/resume`, { body: '{}' });
    ok(res.status === 410, `a resume after the close is refused with GONE, not a 500 (got ${res.status})`);
    ok(!!res.json && /closed on the portal/.test(res.json.error || ''),
      'saying what happened in the desk\'s own words');
    const afterDoc = await requests.getByToken(r.id);
    ok(!!afterDoc.hold && afterDoc.hold.correctedCost === NEW_COST && !afterDoc.holdHistory,
      'and nothing was written - the hold record is exactly as it was, so the held page still renders');
    ok(afterDoc.price.cost === NEW_COST, 'the corrected cost stays on record too - a refused resume restores nothing');

    // NOT ON HOLD. The same button posted twice, or a stale tab, must not re-price a live load back
    // to a cost the desk moved off deliberately.
    const live = await armedWithStandingBid('REC-11');
    const notHeld = await req('POST', `${base}/price/${live.id}/resume`, { body: '{}' });
    ok(notHeld.status === 409, `resuming a load that is not on hold is refused (got ${notHeld.status})`);
    ok((await requests.getByToken(live.id)).price.cost === COST,
      'and it changed nothing');
  }

  console.log('\n11. the correction survives the resume in the close-time record');
  {
    const rec = await store.getDoc('closedBids', 'REC-8');
    ok(!!rec, 'the load has a close-time record to read');
    ok(Array.isArray(rec.costCorrections) && rec.costCorrections.length === 2,
      'both moves are on the append-only trail: the correction, then the resume that withdrew it');
    ok(rec.costCorrections[0].from === COST && rec.costCorrections[0].to === NEW_COST,
      'the desk\'s own correction, as it happened');
    ok(rec.costCorrections[1].from === NEW_COST && rec.costCorrections[1].to === COST
      && rec.costCorrections[1].reason === 'resumed_by_desk',
      'and the resume beside it, named - never in place of it');
    // The LIVE override is the one thing a resume does retire, and it has to be: bidTimeCost reads
    // costCorrection.from as "the cost that priced the bid" wherever the last bid carries no
    // snapshot, and after a resume that cost IS rec.cost again. Leaving it would divide the landed
    // bid by a number the desk had withdrawn and report a margin no bid was ever placed at - the
    // exact defect the correction record was added to fix, pointing the other way.
    ok(rec.costCorrection == null,
      'while the live correction override is withdrawn, so the close receipt prices the bid off the cost that actually priced it');
    // Asserted through the consumer as well as on the field, because the field alone binds nothing:
    // between 2026-09-15 and 2026-09-16 the merge left this record with no reader at all and the
    // check above still passed. A regression in the withdrawal has to show up as a wrong number.
    ok(resolveBidTimeCost(rec) === COST,
      `and the receipt's anchor resolves back to the restored cost (got ${resolveBidTimeCost(rec)})`);
    ok(outcomeEnrichment(rec).marketRate === '29,000',
      `so the rendered "Your Rate" is the restored cost, not the withdrawn 38,000 (got ${outcomeEnrichment(rec).marketRate})`);
  }

  console.log('\n12. the won receipt no longer carries its own correction messaging');
  {
    // The escalated correction alert owns that message now, and it owns it with the gate this one
    // never had: underCorrected was `correction - wonRate` with no check on the sign, so a HEALTHY
    // win whose correction sat below the won rate printed a warning about being under it.
    const { renderMessage } = require('../src/notify/waTemplates');
    const { outcomeEnrichment } = require('../src/notify/engineAlerts');
    const base = { oaNo: 'OA1', from: 'A', to: 'B', vehicleType: '1 x 40FT', attempts: 2,
      closeTime: 'x', finalRank: 1, marketRate: '1,20,000', wonRate: '1,31,000',
      marginPct: '9.17', minMarginPct: 1.8 };
    // The exact shape the defect fired on: correction 1,20,000 -> 1,24,000, won at 1,31,000.
    const enriched = outcomeEnrichment({ won: true, cost: 120_000, lastBidPrice: 131_000,
      minMarginPct: 1.8, ourBids: [{ price: 131_000 }],
      costCorrection: { from: 120_000, to: 124_000, standingBidPrice: 131_000 } });
    ok(enriched.correctedRate === undefined && enriched.underCorrected === undefined,
      'the enrichment no longer emits correction render inputs at all');
    const won = renderMessage('won', Object.assign({}, base, enriched));
    ok(!/Rate corrected to/.test(won), 'so the won receipt cannot print a duplicate corrected-rate line');
    ok((won.match(/⚠/g) || []).length <= 1,
      'and carries at most one warning - a healthy win gets no spurious "under your corrected rate"');
    ok(!/under your corrected rate/.test(won),
      'the ungated subtraction that produced a negative gap on a healthy win is gone');
    ok(/Your Rate/.test(won) && !/Rate when we bid/.test(won),
      'and the rate label is back to the one every other receipt uses');
  }

  server.close();
  if (fail || pass !== EXPECTED_CHECKS) {
    console.error(`\nFAILED: ${fail} failing, ran ${pass} of ${EXPECTED_CHECKS} checks`);
    process.exit(1);
  }
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
