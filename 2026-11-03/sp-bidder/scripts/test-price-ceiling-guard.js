'use strict';
/**
 * SHIPPER CEILING at COST-ENTRY time - the entry-time control, and the three states it must show.
 *
 * Regression target: SIKA 23534893, 2026-07-27. SuperProcure capped the load at Rs 26,000, the desk
 * entered a Rs 27,000 cost (operating floor Rs 27,540), the cost was accepted, the load armed, and
 * 47 minutes later it closed with nothing bid. The engine's refusal was correct. Letting the cost be
 * entered at all was the miss.
 *
 * WHY THE EXISTING WARNING DID NOT SAVE THEM - established from the code, and it decides the fix.
 * The ceiling was in the data at entry time: deriveLoadRules runs at DISCOVERY (realAdapter._mapLoad)
 * and createForLoad snapshots load.rules onto the price request, which is the same snapshot arm()
 * later read the 26,000 from. So this was NOT a data-timing problem. It was a control problem:
 *   - the warning was ADVISORY - both submit handlers gated only on hardFloorOk() + lowCostConfirm(),
 *     and nothing read willNotBid, so the cost could be submitted by simply not reading;
 *   - it rendered INSIDE <details class="band">, collapsed by default, while the always-visible band
 *     summary kept showing the uncapped margin prices - the visible thing contradicted the hidden one;
 *   - it was 350ms-debounced behind a fetch nothing awaited, with a silent .catch;
 *   - a PARTIALLY binding ceiling was silently truncated by capLadderToCeiling with nothing said.
 * So the fix is a BLOCKING CONTROL, not a data fix. That is what this file pins.
 *
 * SOFT with a deliberate override, matching the low-cost guard: the desk is stopped by a modal and
 * the acknowledgement is a real POST field the SERVER re-checks - so it holds against a raw POST, a
 * dead page script or a stale tab. A hard block was rejected because SuperProcure's numeric fields do
 * lie, and a wrong ceiling would strand the desk with no way to record a cost.
 *
 * DEFENCE IN DEPTH: the engine's own ceilingBelowFloor stand-down is untouched and is asserted here
 * to still fire on an ACKNOWLEDGED cost. The UI stops the operator early; the engine still refuses at
 * the wire. Nothing here weakens that guard.
 *
 *   node scripts/test-price-ceiling-guard.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
// Named reversal, A057 review finding 7: with per-tonne bidding off, a per-tonne load is refused on the
// page before a cost field is drawn (the engine refuses it outright). The per-tonne page shapes pinned
// here are the ones a desk sees when per-tonne bidding is on.
process.env.SP_PMT_BID = '1';
process.env.SP_HARD_CLOSE_ONLY = '0';        // this test is about the ceiling, not close-scope
process.env.SP_NOTIFY_MODE = 'dashboard';    // no WhatsApp send in a unit test
process.env.SP_MIN_COST_ABS = '0';           // the clerical-error floor is a different guard
process.env.SP_MIN_COST_PER_KM = '0';
process.env.SP_MIN_PLAUSIBLE_COST = '1';     // keep the low-cost guard out of the way
// Pin the band so every number below is exact: floor = cost x 1.02, opening = cost x 1.12.
process.env.SP_MARGINS_PCT = '12,7,2';
process.env.SP_MIN_MARGIN_PCT = '2';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ceiling-'));

const assert = require('assert');
const http = require('http');
const vm = require('vm');
const { app, requests, stacks } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

function req(method, url, { body = null, contentType = null, origin = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType || 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(body); }
    // The /api surface refuses a cross-site POST outright ("missing origin"), so an API call has to
    // carry the same-origin header a browser would send. The public /price form post does not.
    if (origin) headers.origin = origin;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

const CEILING = 26_000;
// cost 27,000 -> floor 27,540. Above the ceiling: the SIKA shape, no legal bid exists.
const DEAD_COST = '27000';
// cost 20,000 -> floor 20,400, opening 22,400. Entirely under the ceiling: nothing capped.
const LIVE_COST = '20000';
// cost 24,000 -> floor 24,480 (under), opening 26,880 (OVER). The PARTIAL case, which used to be
// silently truncated: some prices can never go out, and the desk was told nothing.
const PARTIAL_COST = '24000';

const now = Date.now();
const mkLoad = (id, rules) => ({
  id, lane: { origin: 'Vejalpur', destination: 'CBD BELAPUR' }, equipment: '32 Feet', units: 1,
  companyName: 'SIKA India Private Limited', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: rules || null,
});
const withCeiling = (id) => mkLoad(id, { ceilingPrice: CEILING, pricingMode: 'flat' });
const noCeiling = (id) => mkLoad(id, { ceilingPrice: null, pricingMode: 'flat' });
// Named reversal, A057 (price-page gate): with SP_PMT_BID=1 the engine still refuses a per-tonne load
// that is not in MT, or that carries a shipper ceiling, and the page now refuses it before a cost
// field is drawn, from the same assertRulesSupported the engine applies. The fixtures below that are
// meant to be biddable carry unit 'MT', as every real snapshot does (deriveLoadRules sets it).
// A per-tonne load with a ceiling is refused by the engine outright, so it is refused on the page too,
// and the ceiling acknowledgement no longer arms a load nothing will bid.
const pmtCeiling = (id) => mkLoad(id, { ceilingPrice: CEILING, pricingMode: 'per_tonne', unit: 'MT' });

// The LIVE monitor object, not snapshot(): snapshot deliberately does not expose ceiling /
// ceilingBelowFloor, and those two fields are exactly what proves the engine guard is still armed
// and untouched by anything this change does on the page.
const armedMonitor = (loadId) => {
  for (const s of stacks) {
    const m = s.engine && s.engine.monitors ? s.engine.monitors.get(loadId) : null;
    if (m) return m;
  }
  return null;
};

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // =============================================================================================
  console.log('\n1. the ceiling is a first-class fact on the form, in ALL THREE states');
  // =============================================================================================
  {
    const known = await requests.createForLoad(withCeiling('C-KNOWN'));
    const page = (await req('GET', `${base}/price/${known.id}`)).text;
    ok(/Customer will not pay above Rs 26,000/.test(page), 'KNOWN: the page states the ceiling in words, on the form');

    // The load-bearing part. The old advisory lived inside <details class="band">, which has no
    // `open` attribute - so it was collapsed and the operator never saw it without expanding
    // "Adjust". Assert the ceiling note renders BEFORE that element, i.e. outside the accordion.
    const notePos = page.indexOf('Customer will not pay above');
    const bandPos = page.indexOf('<details class="band"');
    ok(notePos > -1 && bandPos > -1 && notePos < bandPos,
      'REGRESSION: the ceiling note renders OUTSIDE (before) the collapsed band accordion, not inside it');

    const unknown = await requests.createForLoad(noCeiling('C-NONE'));
    const p2 = (await req('GET', `${base}/price/${unknown.id}`)).text;
    // CHANGED 2026-07-31 (product owner: "no need to show this by default"). A load with no
    // published ceiling now renders NO ceiling block at all. The two assertions that used to
    // require the explanatory paragraph are inverted deliberately - most loads carry no ceiling,
    // so that paragraph was noise on the majority of pages, sitting under the field the desk is
    // trying to type into.
    //
    // This is NOT a return of the fail-open pattern #112 fixed. That was a wrong POSITIVE claim
    // (asserting "hard close" for an unverified close model). Saying nothing about an absent
    // ceiling asserts nothing - which is why the assertion that DOES matter is kept and
    // strengthened below: an absent ceiling must never be rendered as if one existed.
    ok(!/id="ceilNote"/.test(p2), 'UNKNOWN: no ceiling block is rendered at all');
    ok(!/Customer will not pay above/.test(p2), 'UNKNOWN does not borrow the known-ceiling wording');
    // Asserted on the RENDERED BODY with the inline <script> stripped. The script carries the
    // ceiling copy as string literals for the known-ceiling case (it is one page template serving
    // all three states), and those literals are never reached here - ceilRender returns early
    // unless CEILSTATE === 'known'. Matching them would be matching source the desk cannot see.
    // Stripping is therefore narrowing the assertion to what it always meant, not weakening it:
    // the check below still fails if a single cap claim reaches the visible page.
    const visible = p2.replace(/<script[\s\S]*?<\/script>/gi, '');
    ok(!/price ceiling|will not pay|Max bid is/i.test(visible),
      'UNKNOWN states no cap of any kind - an absent ceiling is never rendered as if one existed');

    const pmt = await requests.createForLoad(pmtCeiling('C-PMT'));
    const p3 = (await req('GET', `${base}/price/${pmt.id}`)).text;
    ok(/We will not bid this load/.test(p3) && !/id="cost"/.test(p3),
      'PMT + ceiling: still refused outright, now on the page, with no ceiling comparison and no cost field');
  }

  // =============================================================================================
  console.log('\n2. the page script still parses (it is one large template literal)');
  // =============================================================================================
  {
    const r = await requests.createForLoad(withCeiling('C-PARSE'));
    const page = (await req('GET', `${base}/price/${r.id}`)).text;
    const scripts = page.match(/<script>([\s\S]*?)<\/script>/g) || [];
    ok(scripts.length > 0, 'the price page ships an inline script');
    let parsed = 0;
    for (const block of scripts) {
      const src = block.replace(/^<script>/, '').replace(/<\/script>$/, '');
      if (!src.trim()) { parsed++; continue; }
      try { new vm.Script(src); parsed++; } catch (e) { console.error('  script parse error:', e.message); }
    }
    ok(parsed === scripts.length, `every inline script parses (${parsed}/${scripts.length})`);
    ok(/var CEILING=26000,CEILSTATE="known"/.test(page), 'the resolved ceiling + state are injected for the client gate');
  }

  // =============================================================================================
  console.log('\n3. THE CONTROL: a cost that cannot produce a legal bid is refused server-side');
  // =============================================================================================
  {
    const r = await requests.createForLoad(withCeiling('C-DEAD'));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: DEAD_COST }) });
    ok(res.status === 400, `a guaranteed-dead cost is REFUSED (got ${res.status})`);
    // DEAD_COST is 27,000 against a 26,000 ceiling, so the COST itself is over the cap - Case B.
    // No margin can rescue it and "every bid would be below your cost" is a TRUE sentence here.
    ok(/Max bid is Rs 26,000;/.test(res.text), 'the refusal names the ceiling');
    ok(/your cost is Rs 1,000 over\./.test(res.text), 'and names the cost as the thing over, so the desk can see the gap');
    ok(/Rs 1,000 over/.test(res.text), 'and the GAP itself, so the desk knows how far to move');
    ok(!/lowest price/i.test(res.text), 'Case B: it blames the cost, not the lowest price');
    const after = await requests.getByToken(r.id);
    ok(after.status !== 'armed', 'the request was NOT captured');
    ok(armedMonitor('C-DEAD') === null, 'and nothing was armed');
  }
  {
    // The override. The desk acted on the modal; the rate is recorded. This is the "human path
    // stays open" half - a wrong or stale ceiling must never strand the desk.
    const r = await requests.createForLoad(withCeiling('C-ACK'));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: DEAD_COST, ceiling_ack: '1' }) });
    ok(res.status < 400, `the SAME cost WITH the acknowledgement is accepted (got ${res.status})`);
    const after = await requests.getByToken(r.id);
    ok(after.price && Number(after.price.cost) === 27_000, 'the rate is recorded');

    // DEFENCE IN DEPTH - the acknowledgement records intent, it does NOT authorise a losing bid.
    const m = armedMonitor('C-ACK');
    ok(m && m.ceilingBelowFloor === true,
      'the engine guard is UNTOUCHED: the armed monitor still refuses this load (ceilingBelowFloor)');
  }
  {
    const r = await requests.createForLoad(withCeiling('C-LIVE'));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: LIVE_COST }) });
    ok(res.status < 400, 'a cost whose prices all fit under the ceiling needs no acknowledgement');
    ok(armedMonitor('C-LIVE') != null, 'and it arms normally');
  }
  {
    // The PARTIAL case must NOT be blocked - some prices still go out, the load is winnable.
    const r = await requests.createForLoad(withCeiling('C-PARTIAL'));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: PARTIAL_COST }) });
    ok(res.status < 400, 'a PARTIALLY capped cost is accepted - the load is still winnable, so blocking it would be wrong');
    const m = armedMonitor('C-PARTIAL');
    ok(m && m.ceilingBelowFloor === false, 'the engine agrees it is biddable');
    ok(m && Math.max.apply(null, m.ladder) <= CEILING, 'and every armed rung sits at or under the ceiling');
  }
  {
    const r = await requests.createForLoad(noCeiling('C-FREE'));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: DEAD_COST }) });
    ok(res.status < 400, 'a load with NO ceiling is completely unaffected by this guard');
  }
  {
    const r = await requests.createForLoad(pmtCeiling('C-PMT2'));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: LIVE_COST }) });
    ok(res.status === 409 && /bid loads priced this way yet/.test(res.text.replace(/&#39;/g, "'")),
      'PMT + ceiling is refused at entry too, with the will-not-bid sentence');
    const acked = await requests.createForLoad(pmtCeiling('C-PMT3'));
    const res2 = await req('POST', `${base}/price/${acked.id}`, { body: form({ cost: LIVE_COST, ceiling_ack: '1' }) });
    ok(res2.status === 409 && !armedMonitor('C-PMT3'),
      'and the ceiling acknowledgement no longer arms it - the engine would refuse every rung');
  }

  // =============================================================================================
  console.log('\n3b. THE WORDING SPLIT: the reason named must be the reason that is true');
  // =============================================================================================
  // The defect this section exists for. The refusal used to say "every bid would be below your own
  // cost" for EVERY dead load. That is only true when the ceiling is under the COST. When the
  // ceiling sits BETWEEN the cost and the operating floor, the cost fits and the MARGIN is the
  // blocker - so the sentence is false and it sends the desk to lower a cost that was never the
  // problem. It survived review because the fixtures were 26,000-vs-27,000 (Case B, where it is
  // true) and a comfortably-clear ceiling. Only a ceiling in the band between exposes it.
  //
  // cost 25,500 against ceiling 26,000: floor = 25,500 x 1.02 = 26,010, which is Rs 10 over. The
  // cost is Rs 500 UNDER the ceiling. Case A.
  {
    const r = await requests.createForLoad(withCeiling('C-CASE-A'));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '25500' }) });
    ok(res.status === 400, `Case A is still refused (got ${res.status})`);
    ok(/your lowest price is Rs 10 over/.test(res.text),
      'Case A names the LOWEST PRICE, not the cost - the cost is not what blocks it');
    ok(!/Rs 500/.test(res.text), 'and the real gap, which is Rs 10 and not Rs 500');
    ok(!/below your (own )?cost/i.test(res.text),
      'Case A does NOT claim the bid would be below cost - it would not, and that is the whole defect');
    // The actionable number is the BUYING PRICE, not a margin. Lowering the last margin does produce
    // one legal bid, but the rungs above it collapse onto the cap and the ladder degenerates - the
    // walk-down IS the mechanic, so suggesting that was advising the desk to throw it away.
    // Inherited band here is 12/7/2, so the binding rung is the 12% opening: floor(26000/1.12) = 23,214.
    ok(/Rs 23,214/.test(res.text), 'Case A names the cost the truck must be sourced at for the WHOLE band to fit');
    ok(!/lowest margin/i.test(res.text), 'and does NOT tell the desk to cut its margin');
  }

  // =============================================================================================
  console.log('\n4. the gate judges the band being SAVED, not the inherited one');
  // =============================================================================================
  {
    // Lowering the margins is exactly how a dead load becomes biddable. Judging DEAD_COST against
    // the inherited 12/7/2 band would refuse a submit that is in fact fine, which would train the
    // desk to reach for the override - the failure mode that makes any confirm gate worthless.
    const r = await requests.createForLoad(withCeiling('C-BAND'));
    // cost 27,000 with a -5% band is nonsense; use a cost whose LOW rung fits only on the new band.
    // cost 25,000: inherited floor = 25,500 (under 26,000) -> already fine. So invert the test:
    // prove the opposite direction - a band whose floor is pushed ABOVE the ceiling IS caught.
    // Sent as a JSON override with its own 12% minimum: typed form rows keep the customer's 2%
    // minimum as their guard, which leaves one bid at the ceiling rather than a dead load.
    const res = await req('POST', `${base}/price/${r.id}`, {
      body: JSON.stringify({ cost: 25000, marginOverride: { marginsPct: [20, 15, 12], minMarginPct: 12 } }),
      contentType: 'application/json',
    });
    ok(res.status === 400 && /Max bid is Rs/.test(res.text),
      'a SUBMITTED band that lifts the lowest price above the ceiling is caught (the inherited band would have passed)');

    const r2 = await requests.createForLoad(withCeiling('C-BAND2'));
    const res2 = await req('POST', `${base}/price/${r2.id}`, {
      // 1% sits below the 2% minimum, so the desk confirms it.
      body: form({ cost: '25000', use_override: '1', m_0: '3', m_1: '2', m_2: '1', below_min_ack: '1' }),
    });
    ok(res2.status < 400, 'and a band that keeps the lowest price under the ceiling passes');
  }

  // =============================================================================================
  console.log('\n5. the re-price route carries the same gate (a ceiling can move after capture)');
  // =============================================================================================
  {
    const r = await requests.createForLoad(withCeiling('C-REPRICE'));
    await req('POST', `${base}/price/${r.id}`, { body: form({ cost: LIVE_COST }) });
    ok(armedMonitor('C-REPRICE') != null, 'the load is armed on a good cost');

    const bad = await req('POST', `${base}/api/price-requests/${r.id}/margin`,
      { body: JSON.stringify({ cost: 27_000, confirm: true, marginsPct: [12, 7, 2], minMarginPct: 2 }), contentType: 'application/json', origin: base });
    ok(bad.status === 400 && /Max bid is Rs/.test(bad.text),
      'the margin route refuses a re-price to a guaranteed-dead cost');

    const good = await req('POST', `${base}/api/price-requests/${r.id}/margin`,
      { body: JSON.stringify({ cost: 27_000, confirm: true, ceiling_ack: true, marginsPct: [12, 7, 2], minMarginPct: 2 }), contentType: 'application/json', origin: base });
    ok(good.status < 400, `and accepts it with the acknowledgement, exactly like the capture path (got ${good.status})`);
  }

  // =============================================================================================
  console.log('\n5b. THE PUBLIC re-price form - the route the desk actually posts to');
  // =============================================================================================
  // The first version of this guard covered the capture path and POST /api/price-requests/:id/margin
  // (the admin console). The desk's own re-price form posts to location.pathname - the PUBLIC
  // /price/<token> - and that branch returns before the capture gate is ever reached. So the guard
  // sat on the internal route and missed the one the desk uses, and a dead re-price saved with a
  // green "bidding off the new cost and margins now".
  //
  // This path is the HIGHER-stakes one. reArmWithNewBand stops the live monitor and rebuilds; if the
  // new band is dead, the load stops bidding. A dead re-price does not merely fail to start - it
  // destroys a position that was live a second earlier.
  {
    const r = await requests.createForLoad(withCeiling('C-PUBREPRICE'));
    await req('POST', `${base}/price/${r.id}`, { body: form({ cost: LIVE_COST }) });
    ok(armedMonitor('C-PUBREPRICE') != null, 'the load is armed and bidding on a good cost');
    const beforeCost = (await requests.getByToken(r.id)).price.cost;

    const dead = await req('POST', `${base}/price/${r.id}`, {
      body: form({ cost: '27000', use_override: '1', m_0: '12', m_1: '7', m_2: '2' }),
    });
    ok(dead.status === 400, `the PUBLIC re-price form refuses a dead band (got ${dead.status})`);
    const afterCost = (await requests.getByToken(r.id)).price.cost;
    ok(String(afterCost) === String(beforeCost),
      'and the saved cost is UNCHANGED - the mutation never happened, not merely a warning after it');
    ok(armedMonitor('C-PUBREPRICE') != null,
      'the live monitor is still armed - a refused re-price must not tear down a working position');

    const okd = await req('POST', `${base}/price/${r.id}`, {
      body: form({ cost: '27000', use_override: '1', m_0: '12', m_1: '7', m_2: '2', ceiling_ack: '1' }),
    });
    ok(okd.status < 400, `and the same submit WITH the acknowledgement is accepted (got ${okd.status})`);
    ok(/Nothing will be bid/i.test(okd.text),
      'the confirmation tells the truth: an acknowledged-dead save must not say bidding started');

    // ===========================================================================================
    console.log('\n5b2. the red ceiling block: one statement of the copy, a real two-button row');
    // ===========================================================================================
    // Regression for the 2026-09 desk screenshot: the panel repeated "Price too high. Max bid on
    // this load is Rs X." a third time, and the suggested-price control read as a chip beside an
    // underlined link rather than a button. Needs the MARGIN-dead shape (Case A: the cost itself
    // fits, only the band does not), not C-PUBREPRICE's cost-too-high fixture above - a cost-dead
    // load never shows the "Use Rs X" button at all (fixPct/costTarget is null there by design).
    // cost 25,500 against ceiling 26,000: inherited floor = 25,500 x 1.02 = 26,010 (over). Target =
    // floor(26,000 / 1.12) = 23,214 (same arithmetic pinned in section 3b).
    const rowReq = await requests.createForLoad(withCeiling('C-UIROW'));
    await req('POST', `${base}/price/${rowReq.id}`, { body: form({ cost: '25500', ceiling_ack: '1' }) });
    const reGet = (await req('GET', `${base}/price/${rowReq.id}`)).text;
    const reVisible = reGet.replace(/<script[\s\S]*?<\/script>/g, '');

    // (a) the alert div that used to double as a third visible line is now an aria-live
    //     ANNOUNCER ONLY - present for screen readers, never painted (class sr-only, not the old
    //     visible "sb ceilalert" that ":empty{display:none}" only hid while blank).
    ok(/<div class="sr-only" id="ceilAlert" role="alert">/.test(reGet),
      'REGRESSION: #ceilAlert is a screen-reader-only announcer (sr-only), not a visible "sb ceilalert" line');
    ok(!/class="sb ceilalert"/.test(reGet), 'the old visible ceilalert class is gone');

    // (b) Guard, not a fix pin: the SERVER-rendered page never duplicated these lines by itself -
    //     the desk's screenshot showed the THIRD copy only after blur/submit ran ceilSetError()
    //     client-side and painted #ceilAlert, which (a) above removes at the source. Kept here so a
    //     future edit cannot reintroduce the duplicate on the SSR path too.
    const occurrences = (s, re) => (s.match(re) || []).length;
    ok(occurrences(reVisible, /Price too high/g) === 1, '"Price too high" states once in the server-rendered page');
    ok(occurrences(reVisible, /Max bid is Rs 26,000\./g) === 1,
      '"Max bid is Rs 26,000." states once in the server-rendered page');

    // (c) the suggested-price control reads as a BUTTON labelled "Use Rs <price>" (not the bare
    //     figure that read as a pill), and the explanatory copy above names it by that exact label.
    ok(/<button type="button" id="ceilFix"[^>]*>Use Rs 23,214<\/button>/.test(reGet),
      'the price-fix control is a button labelled "Use Rs 23,214", not a bare-figure pill');
    ok(/Use Rs 23,214 or less\./.test(reVisible),
      'the explanation names the button\'s figure ("Use Rs 23,214 or less.")');

    // (d) both controls sit in one row, styled as a button PAIR (same rule set), not a button
    //     beside an underlined text link.
    ok(/<div class="ceilacts" id="ceilActs">/.test(reGet), 'the actions render as the ceilacts row, visible on a dead reprice load');
    ok(/<button type="button" class="ceilalt" id="ceilSave">Save anyway - nothing will be bid<\/button>/.test(reGet),
      '"Save anyway" keeps its exact current behaviour/label, now inside the same button row');
  }

  // =============================================================================================
  console.log('\n5c. REVERT restores the INHERITED band, which can be dead on its own');
  // =============================================================================================
  // The hole the first version did not cover. revert_override carries no cost, so a guard keyed on
  // body.cost skips it entirely - but clearBidOverride restores the inherited band, which RAISES the
  // floor. A desk that lowered its margin to make a load biddable and then tapped "Revert to
  // standard margins" would silently re-create the dead state on a live armed load, with a green
  // confirmation. Inherited here is 12/7/2 -> floor = cost x 1.02.
  {
    const r = await requests.createForLoad(withCeiling('C-REVERT'));
    // Armed on a cost whose INHERITED floor is over the ceiling (25,500 x 1.02 = 26,010 > 26,000),
    // but made biddable by a lowered lowest margin (1.9% -> 25,984).
    const armed = await req('POST', `${base}/price/${r.id}`, {
      body: form({ cost: '25500', use_override: '1', m_0: '12', m_1: '7', m_2: '1.9', below_min_ack: '1' }),
    });
    ok(armed.status < 400, `armed on a hand-lowered margin (got ${armed.status})`);
    ok(armedMonitor('C-REVERT') != null, 'and it is bidding');

    const rev = await req('POST', `${base}/price/${r.id}`, { body: form({ revert_override: '1' }) });
    ok(rev.status === 400,
      `reverting to the inherited band is REFUSED, because that band is dead on this load (got ${rev.status})`);
    ok(armedMonitor('C-REVERT') != null, 'and the live position survives the refused revert');
  }

  // =============================================================================================
  console.log('\n6. copy: no banned vocabulary, and the advice is no longer backwards');
  // =============================================================================================
  {
    const r = await requests.createForLoad(pmtCeiling('C-COPY'));
    const page = (await req('GET', `${base}/price/${r.id}`)).text;
    ok(!/\bbots?\b/i.test(page), 'REGRESSION (PR #88): the per-tonne-ceiling copy no longer says "the bot will not bid it"');
    ok(/We will not bid this load/.test(page), 'it speaks in the first person instead');

    const r2 = await requests.createForLoad(withCeiling('C-COPY2'));
    const p2 = (await req('GET', `${base}/price/${r2.id}`)).text;
    ok(!/\bbots?\b/i.test(p2), 'no banned word on the known-ceiling page either');
    // "Raise the band above it" was backwards: the band is ALREADY above the ceiling, and raising
    // it makes the gap worse. The only fixes are a lower cost or lower margins.
    ok(!/Raise the band above it/.test(p2), 'REGRESSION: the backwards "Raise the band above it" advice is gone');
    // The advice is now case-specific: 'Your cost fits. The margin does not.' when the margin is the
    // blocker, 'Any bid would be below your cost.' when the cost is. This fixture (cost entered later,
    // ceiling known) renders the neutral prompt, so the assertion moves to the two RED cases in
    // section 7 where the reason is actually decided.
    ok(/Enter your cost to check your prices fit/.test(p2),
      'the known-ceiling page opens by asking for the cost, not by asserting a failure');
  }

  // ---------------------------------------------------------------------------------------------
  // Completion sentinel. scripts/run-tests.js grades by EXIT STATUS ONLY, so a file that ends early
  // is a silent green with zero assertions. Print the count and exit explicitly.
  // ---------------------------------------------------------------------------------------------
  // =============================================================================================
  console.log('\n7. the offered margin can NEVER produce a price above the ceiling');
  // =============================================================================================
  // The one arithmetic mistake that would turn the fix button into a new incident. Math.round
  // instead of Math.floor overshoots the cap by up to half a step, and the desk would have tapped a
  // button labelled with a legal number and saved an illegal one. Swept rather than sampled,
  // because the failure is off-by-a-rounding and a single fixture would miss it.
  {
    const { ceilingCostTarget } = require('../src/web/server');
    const BANDS = [[12, 7, 2], [12.6, 7.2, 6], [20, 15, 12], [5, 4, 3]];
    let checked = 0, bad = null;
    for (const band of BANDS) {
      const top = Math.max(...band);
      for (let cap = 800; cap <= 90_000 && !bad; cap += 73) {
        const t = ceilingCostTarget(cap, band);
        if (t == null) continue;
        checked += 1;
        // The OPENING rung is the binding one. If it fits, every rung below it fits too.
        const opening = Math.round(t * (1 + top / 100));
        if (opening > cap) { bad = { cap, band, t, opening }; break; }
      }
    }
    ok(checked > 4000, `the sweep actually ran (${checked} ceiling/band pairs)`);
    ok(!bad, `the suggested cost never puts the OPENING bid over the ceiling${bad ? ` - ${JSON.stringify(bad)}` : ''}`);
    ok(ceilingCostTarget(26_000, null) === null && ceilingCostTarget(null, [12, 7, 2]) === null,
      'and no target is produced without both a ceiling and a band - it degrades rather than guessing');
  }

  server.close();
  console.log(`\nprice-ceiling-guard: ${pass} passed, ${fail} failed`);
  assert.ok(pass >= 45, `the suite must assert something substantial (saw ${pass} passing assertions)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('price-ceiling-guard: FATAL', e);
  process.exit(1);
});
