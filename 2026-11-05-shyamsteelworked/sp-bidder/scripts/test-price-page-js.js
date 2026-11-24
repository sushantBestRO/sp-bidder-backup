'use strict';
/**
 * The gate that should have existed on 2026-07-10.
 *
 * The /price and /track pages are HTML *and* JavaScript assembled by hand inside Node template
 * literals. Nothing compiles that JavaScript: a stray escape produces a page that still returns
 * 200, still renders, still looks right - and whose <script> silently never runs. That is not a
 * hypothetical. Commit 362b8a9 ("drop 'bot' wording from all user-facing UI text") wrote an
 * apostrophe as \' inside a template literal, where the backslash is consumed at render time.
 * The browser received  'it's already covered'  - string closed early, SyntaxError - and the
 * capture page's countdown, its cutoff lock, and its /state poll were dead for four days.
 * Operators saw a form with no timer, typed a cost past the cutoff, and had it discarded
 * (loads 23107518 and 23128437). No test noticed, because no test had ever asked the only
 * question that mattered: does the JavaScript we ship actually parse?
 *
 * PART 1 asks exactly that, of every inline <script> on every public page state.
 * PART 2 pins the cutoff behaviour those scripts (and the server) are supposed to enforce.
 *
 * Deliberately parses the SHIPPED bytes over real HTTP rather than reading the source: the bug
 * lives in the gap between what the source says and what the template literal emits, so reading
 * the source is precisely the check that cannot catch it.
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
// Named reversal, A057 review finding 7: with per-tonne bidding off, a per-tonne load is refused on the
// page before a cost field is drawn (the engine refuses it outright). The per-tonne page shapes pinned
// here are the ones a desk sees when per-tonne bidding is on.
process.env.SP_PMT_BID = '1';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const assert = require('assert');
const http = require('http');
const { app, store } = require('../src/web/server');
const { PriceRequestStore, publicSeg } = require('../src/pricing/priceRequests');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// ------------------------------------------------------------------------------------------------
// EXPECTED-COUNT SENTINEL - registered HERE, above every check, and fired on process exit.
//
// scripts/run-tests.js grades this file by EXIT CODE ALONE, and this file is ASYNC and holds an HTTP
// server open. A swallowed rejection or an early return reaches exit 0 having asserted nothing and
// reads as a silent green zero-assertion run - the "N passed, 0 failed" line at the bottom cannot
// catch that, because every path that exits early skips it too. Counting pass + fail (not pass) is
// deliberate: a failure must still be a count MATCH, so the "did every check run" question and the
// "did every check pass" question stay separate and neither can mask the other.
// ------------------------------------------------------------------------------------------------
const EXPECTED_CHECKS = 132;
process.on('exit', () => {
  if (pass + fail === EXPECTED_CHECKS) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass + fail} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were added/removed without updating the count');
  process.exitCode = 1;
});

function get(base, path) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

/** POST an application/x-www-form-urlencoded body (the capture form's own content type). */
function postForm(base, path, fields) {
  const body = Object.keys(fields).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(fields[k])}`).join('&');
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Every <script>...</script> body on the page, in document order. */
function inlineScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) if (m[1].trim()) out.push(m[1]);
  return out;
}

/**
 * Parse a script body the way a browser would. `new Function` compiles without executing, so
 * this catches SyntaxError (the whole point) without needing a DOM.
 */
function parses(src) {
  try { new Function(src); return null; } catch (e) { return e.message; }
}

const load = (over = {}) => ({
  id: 'L-1',
  lane: { origin: 'Pune', destination: 'Banglore' },
  companyName: "ADAMA India Private Limited",
  equipment: '32 Feet', units: 1,
  weight: 16, weightUnit: 'MT',
  closesAt: Date.now() + 20 * 60_000,
  softClose: false, closeModelKnown: true,
  ...over,
});

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const requests = new PriceRequestStore({ store, marginsPct: [12, 8, 6], minMarginPct: 6, platformKey: 'sp' });

  // ---------------------------------------------------------------------------------------
  // PART 1 - every inline script on every public page state must PARSE.
  // ---------------------------------------------------------------------------------------
  console.log('\n1. every shipped inline <script> parses');

  const openReq = await requests.createForLoad(load(), { deadlineAt: Date.now() + 18 * 60_000 });
  const armedReq = await requests.createForLoad(load({ id: 'L-2' }), { deadlineAt: Date.now() + 18 * 60_000 });
  await requests.capture(armedReq.id, { cost: 50_000 });

  const expiredReq = await requests.createForLoad(load({ id: 'L-4' }), { deadlineAt: Date.now() - 60_000 });
  await requests.expireOverdue(Date.now());

  // A request whose cutoff has passed but which is STILL stored as awaiting_price - the state
  // expireOverdue() has not swept yet. Created after the sweep above on purpose, because that
  // is the real window: on the live box the status lagged the cutoff by up to 45s, and the
  // server served a fully live cost form for the whole of it.
  const staleReq = await requests.createForLoad(load({ id: 'L-3' }), { deadlineAt: Date.now() - 30_000 });

  // A TRUCK-basis multi-vehicle load (units>1 with a recorded FTL basis): the backend reads the basis
  // off quoteType and renders the editable count control ("[N] / N trucks") + a per-TRUCK cost label.
  // Included here so PART 1 also parses the page WITH the control rendered; PART 4 asserts the visible
  // net. (Mock mode -> a recorded FTL basis triggers the truck path without the real-mode lever.)
  const mvReq = await requests.createForLoad(load({ id: 'L-MV', units: 2, quoteType: 'FTL' }), { deadlineAt: Date.now() + 18 * 60_000 });
  // A PMT (per-metric-tonne) load: `units` is the tonnage, not trucks. The page renders the same
  // control shape but READ-ONLY (the tonnage is fixed by the load) + a per-METRIC-TONNE cost label.
  const pmtReq = await requests.createForLoad(load({ id: 'L-PMT', units: 22, quoteType: 'PMT' }), { deadlineAt: Date.now() + 18 * 60_000 });
  // A SPLIT PMT load - the captured 23828313 shape: 30 MT total across 2 trucks of 15. `vcq:-1` does
  // not mean one vehicle on a PMT load (SuperProcure derives the count from the load and recorded 2),
  // so this page has to state the TRUCK commitment or the desk prices a two-truck obligation it was
  // never shown. LoadRules.pmtVehicleCount is what carries that count to the page.
  const pmtSplitReq = await requests.createForLoad(load({ id: 'L-PMT-SPLIT', units: 30, weight: 15,
    quoteType: 'PMT', rules: { pricingMode: 'per_tonne', unit: 'MT', pmtQuantity: 30, pmtVehicleCount: 2 } }),
  { deadlineAt: Date.now() + 18 * 60_000 });
  // ...and the single-truck PMT shape (live Rajratan 23129542: vehicleCount 18 == weight 18 -> 1).
  const pmtSingleReq = await requests.createForLoad(load({ id: 'L-PMT-ONE', units: 18, weight: 18,
    quoteType: 'PMT', rules: { pricingMode: 'per_tonne', unit: 'MT', pmtQuantity: 18, pmtVehicleCount: 1 } }),
  { deadlineAt: Date.now() + 18 * 60_000 });
  // A KG-QUOTED PMT load. Ashirvad Pipes and Tata Consumer really are configured in KG, and this page
  // renders for them: PMT_UNIT gates the WIRE, not the pricing form, so the bot refuses to bid while
  // the desk is still shown this page and still types a cost into it. Every quantity word here must
  // come off the load's own weightUnit - a hardcoded "metric tonnes" overstates a KG load by ~1000x
  // on the one line whose entire job is saying what the bid commits to.
  const pmtKgReq = await requests.createForLoad(load({ id: 'L-PMT-KG', units: 9000, weight: 4500,
    weightUnit: 'KG', quoteType: 'PMT', rules: { pricingMode: 'per_tonne', unit: 'KG', pmtQuantity: 9000, pmtVehicleCount: 2 } }),
  { deadlineAt: Date.now() + 18 * 60_000 });
  // A TRANSITIONAL snapshot: pricingMode already correct, but captured before pmtVehicleCount existed.
  // reconcilePricingMode cannot heal this (a persisted snapshot carries neither vehicleCount nor
  // weight), but this page is not so limited - it holds the load itself, which carries both - so it
  // must re-derive rather than tell the desk the count is unknown on a load that plainly states it.
  const pmtStaleReq = await requests.createForLoad(load({ id: 'L-PMT-STALE', units: 30, weight: 15,
    quoteType: 'PMT', rules: { pricingMode: 'per_tonne', unit: 'MT', pmtQuantity: 30 } }),
  { deadlineAt: Date.now() + 18 * 60_000 });

  const pages = [
    ['/price/ (awaiting a cost)', `/price/${publicSeg(openReq)}`],
    ['/price/ (armed -> re-price form)', `/price/${publicSeg(armedReq)}`],
    ['/price/ (cutoff passed, not yet swept)', `/price/${publicSeg(staleReq)}`],
    ['/price/ (expired)', `/price/${publicSeg(expiredReq)}`],
    ['/price/ (truck multi-vehicle count control)', `/price/${publicSeg(mvReq)}`],
    ['/price/ (PMT per-metric-tonne)', `/price/${publicSeg(pmtReq)}`],
    ['/price/ (PMT split across 2 trucks)', `/price/${publicSeg(pmtSplitReq)}`],
    ['/price/ (PMT on a single truck)', `/price/${publicSeg(pmtSingleReq)}`],
    ['/track/ (read-only live view)', `/track/${publicSeg(armedReq)}`],
  ];

  let scriptsChecked = 0;
  for (const [label, path] of pages) {
    const res = await get(base, path);
    ok(res.status === 200 || res.status === 410, `${label}: served (${res.status})`);
    const scripts = inlineScripts(res.body);
    for (let i = 0; i < scripts.length; i++) {
      const err = parses(scripts[i]);
      scriptsChecked++;
      ok(err === null, `${label}: inline script #${i + 1} parses${err ? ` -> ${err}` : ''}`);
    }
  }
  ok(scriptsChecked >= 5, `checked a meaningful number of scripts (${scriptsChecked})`);

  const openHtml = (await get(base, `/price/${publicSeg(openReq)}`)).body;

  // Ban the footgun at source, not just its symptom. Inside a template literal Node collapses
  // \' to a bare apostrophe, so it does NOT escape anything in the emitted JS - it closes the
  // string. There is no legitimate use of it in this file: page copy goes through JSON.stringify
  // (which cannot mis-escape) and the odd typographic quote is written \\u2019. PART 1 above
  // catches the breakage empirically; this catches the pattern before it can render.
  const SRC = require('fs').readFileSync(require('path').join(__dirname, '../src/web/server.js'), 'utf8');
  ok(!/\\'/.test(SRC),
    "server.js uses no \\' escape (inside a template literal it collapses to a bare ' and closes the emitted JS string - the 362b8a9 bug). Use JSON.stringify for message text.");

  // And the messages themselves must be handed over as JSON, not hand-quoted into a ternary.
  const guardEarly = inlineScripts(openHtml).find((s) => /function tick\(/.test(s));
  ok(!!guardEarly && /var MSG=\{"/.test(guardEarly),
    'guard-script copy is emitted via JSON.stringify, not hand-escaped string literals');

  // ---------------------------------------------------------------------------------------
  // PART 1b - the live countdown/red-alert banner (#closewarn), tiered off the engine's OWN
  // real timing thresholds (never a hand-copied number that could silently drift).
  // ---------------------------------------------------------------------------------------
  console.log('\n1b. the #closewarn countdown banner is present, wired to the engine\'s real thresholds');

  const { PRICE_ALERT_AMBER_MS, PRICE_ALERT_RED_MS } = require('../src/web/server');
  ok(Number.isFinite(PRICE_ALERT_AMBER_MS) && PRICE_ALERT_AMBER_MS > 0, 'PRICE_ALERT_AMBER_MS is a real positive number');
  ok(Number.isFinite(PRICE_ALERT_RED_MS) && PRICE_ALERT_RED_MS > 0 && PRICE_ALERT_RED_MS < PRICE_ALERT_AMBER_MS,
    'PRICE_ALERT_RED_MS is a real positive number, tighter than the amber threshold');

  ok(/<div class="closewarn" id="closewarn"/.test(openHtml), 'the capture form ships the #closewarn element');
  const armedHtml = (await get(base, `/price/${publicSeg(armedReq)}`)).body;
  ok(/<div class="closewarn" id="closewarn"/.test(armedHtml), 'the re-price form ships the #closewarn element too');

  ok(!/closewarn amber|closewarn red/.test(openHtml.replace(/<script[\s\S]*?<\/script>/g, '')),
    'server-rendered HTML never carries an amber/red class by itself - only client JS applies it live');

  // Source-level pin (this file's own established style for tick()'s behaviour, e.g. the
  // target=cutoff check below) - execution against a live countdown is a browser concern,
  // not something `new Function` parsing can exercise.
  ok(/var danger=deadlineAt&&now\(\)>=deadlineAt/.test(guardEarly), 'tick() computes the danger zone off deadlineAt (past it = inside the lead before close)');
  ok(/if\(danger\)\{cw\.className='closewarn red'/.test(guardEarly), 'tick() shows the red "best-effort, may not land" banner in the danger zone (past deadlineAt)');
  ok(/else if\(soon\)\{cw\.className='closewarn amber'/.test(guardEarly), 'tick() shows the amber "closing soon" banner approaching the danger zone');
  ok(/cw\.className='closewarn';cw\.textContent='';/.test(guardEarly), 'tick() clears the banner once remaining time is comfortably above both tiers');
  ok(/function lock\(msg\)\{[\s\S]*clearCloseWarn\(\);\}/.test(guardEarly),
    'lock() also clears the banner once the form is closed for pricing (no stale urgency text under a locked form)');

  // ---------------------------------------------------------------------------------------
  // PART 2 - the cutoff is real, enforced, and VISIBLE without JavaScript.
  // ---------------------------------------------------------------------------------------
  console.log('\n2. the pricing cutoff is enforced and disclosed');

  // (a) Disclosed in server-rendered HTML. A guard that only exists in JavaScript does not
  //     exist - that is the entire lesson of this outage. Strip the scripts, then look.
  const htmlOnly = openHtml.replace(/<script[\s\S]*?<\/script>/g, '');
  ok(/Cost by/i.test(htmlOnly), 'the load card names the cutoff ("Cost by") in plain HTML');
  ok(/Enter your cost by/i.test(htmlOnly), 'the form states the cutoff in plain HTML, no JS needed');

  // (b) The countdown counts to the real CLOSE (deadlineAt is no longer a wall - a late cost/re-price
  //     is accepted best-effort right up to close). The form locks only when the AUCTION closes, and
  //     the lock says the auction is over - never that "we" cut the operator off.
  const guard = inlineScripts(openHtml).find((s) => /function tick\(/.test(s));
  ok(!!guard, 'the capture page ships a countdown/guard script');
  ok(/var wall\s*=\s*closesAt\|\|deadlineAt/.test(guard),
    'the countdown targets the real close (closesAt), not the advisory deadlineAt');
  ok(/if\(wall&&\(wall-now\(\)\)<=0\)\{lock\(/.test(guard),
    'the guard locks only when the auction actually closes, never at the advisory deadline');
  ok(/Auction closed - bidding on this load has finished/.test(guard),
    'the re-price lock says the auction closed and bidding finished (never "we blocked you"), no automation wording');

  // (c) A request past the advisory deadline but with the auction STILL OPEN (staleReq: deadlineAt in
  //     the past, closesAt 20min out) still serves a live, submittable form - the operator can price
  //     it best-effort. Only a genuinely-closed auction gets the terminal page.
  const stale = await get(base, `/price/${publicSeg(staleReq)}`);
  ok(stale.status === 200, `danger-zone request (deadline passed, auction open) still serves the form (got ${stale.status})`);
  ok(/<form[^>]*id="mainForm"/.test(stale.body), 'danger-zone request DOES render a submittable cost form');
  ok(!/This auction has closed/i.test(stale.body), 'danger-zone form does not falsely say the auction closed');

  // (d) capture() in the danger zone (deadline passed, auction still open) SUCCEEDS - a late cost is
  //     accepted best-effort, not thrown away. It refuses only once the auction has actually closed.
  const dangerReq = await requests.createForLoad(load({ id: 'L-5' }), { deadlineAt: Date.now() - 5_000 });
  const dangerCap = await requests.capture(dangerReq.id, { cost: 50_000 });
  ok(dangerCap.status === 'armed' && dangerCap.price.cost === 50_000,
    'a late cost in the danger zone is accepted and arms the engine (best-effort), never thrown away');
  const closedReq2 = await requests.createForLoad(load({ id: 'L-5b', closesAt: Date.now() - 1_000 }), { deadlineAt: Date.now() - 40_000 });
  let closedCode = null;
  try { await requests.capture(closedReq2.id, { cost: 50_000 }); } catch (e) { closedCode = e.code; }
  ok(closedCode === 'GONE', `capture() past the real close throws GONE (got ${closedCode})`);

  // (e) ...and a cost inside the window still captures normally. The guard must not eat the
  //     happy path.
  const goodReq = await requests.createForLoad(load({ id: 'L-6' }), { deadlineAt: Date.now() + 10 * 60_000 });
  const captured = await requests.capture(goodReq.id, { cost: 50_000 });
  ok(captured.status === 'armed' && captured.price.cost === 50_000,
    'a cost entered before the cutoff still captures and arms');

  // (g) Once the auction has actually CLOSED on the portal (now past closesAt), the page must say
  //     THAT - the portal is no longer accepting bids - not blame our pricing cutoff. Past the
  //     cutoff but before close, the portal still accepts; past close it does not and the load is
  //     gone. Different, stronger fact, and the operator needs to know which.
  const closedReq = await requests.createForLoad(load({ id: 'L-7', closesAt: Date.now() - 60_000 }), { deadlineAt: Date.now() - 95_000 });
  const closedPage = await get(base, `/price/${publicSeg(closedReq)}`);
  ok(closedPage.status === 410, `closed-auction request is 410 (got ${closedPage.status})`);
  ok(/This auction has closed/i.test(closedPage.body), 'closed-auction page leads with the auction being closed, not our cutoff');
  ok(/no longer accepting bids/i.test(closedPage.body), 'closed-auction page states the portal is no longer accepting bids');
  ok(!/Too late to price this load/i.test(closedPage.body), 'closed-auction page does not blame our pricing cutoff');

  // (f) The rejection must not tell the operator they entered nothing when they entered a
  //     number. "expired before a cost was entered" is a false statement about their own work.
  const lateHtml = (await get(base, `/price/${publicSeg(expiredReq)}`)).body;
  ok(!/expired before a cost was entered/i.test(lateHtml),
    'the expired page no longer claims "expired before a cost was entered"');
  ok(/cutoff/i.test(lateHtml), 'the expired page explains the cutoff instead');

  // ---------------------------------------------------------------------------------------
  // PART 3 - embedding data in an inline <script> is safe BY CONSTRUCTION.
  //
  // JSON.stringify is not an output encoder (OWASP DOM-XSS cheat sheet says so explicitly).
  // Two holes, both of which kill the script exactly as silently as the apostrophe did:
  //   - `</script>` in any string value: the HTML parser ends the element there, inside a JS
  //     string literal or not, and the remainder lands in the document as markup.
  //   - U+2028 / U+2029: legal in JSON, but JavaScript line terminators.
  // No value we embed today is user-controlled, so neither is reachable - but the obvious next
  // edit is putting the shipper name or the shipper's free-text NOTE into a message, and both
  // come from SuperProcure. Pin the property now, while it is still true.
  // ---------------------------------------------------------------------------------------
  console.log('\n3. script-embedded data survives hostile values');

  const { jsonForScript } = require('../src/web/server');
  ok(typeof jsonForScript === 'function', 'jsonForScript is exported for the seam it protects');

  // The payloads that break a naive JSON.stringify embed.
  const hostile = [
    ['closing script tag', 'ADAMA </script><img src=x onerror=alert(1)> Ltd'],
    ['html comment open', 'note <!-- hidden'],
    ['nested script open', 'note <script>evil()</script>'],
    ['U+2028 line separator', 'note \u2028 after'],
    ['U+2029 paragraph separator', 'note \u2029 after'],
    ['quotes and backslash', `it's "quoted" \\ and 'single'`],
  ];

  for (const [label, payload] of hostile) {
    const emitted = jsonForScript({ note: payload });

    // (a) the emitted text must not contain a sequence the HTML parser will act on
    ok(!/<\/script/i.test(emitted), `${label}: emits no raw </script`);
    ok(!/<!--/.test(emitted), `${label}: emits no raw <!--`);
    ok(!/[\u2028\u2029]/.test(emitted), `${label}: emits no raw U+2028/U+2029`);

    // (b) it must still PARSE as JS...
    const err = parses(`var d=${emitted};`);
    ok(err === null, `${label}: still parses as JS${err ? ` -> ${err}` : ''}`);

    // (c) ...and round-trip to the EXACT original value. Escaping that mangles the data is
    //     not a fix, it is a different bug.
    let roundTripped = null;
    try { roundTripped = new Function(`return ${emitted};`)(); } catch (_) {}
    ok(roundTripped && roundTripped.note === payload, `${label}: round-trips to the exact value`);
  }

  // And prove the naive form we replaced really was vulnerable - otherwise this is theatre.
  const naive = JSON.stringify({ note: 'x </script> y' });
  ok(/<\/script/i.test(naive), 'control: bare JSON.stringify DOES emit a raw </script (so the hardening is load-bearing)');

  // ---------------------------------------------------------------------------------------
  // PART 4 - the multi-unit count control + per-unit cost label. The BACKEND reads the basis
  // (trucks vs PMT) off the SP data (quoteType); the desk never picks it. A TRUCK load gets an
  // EDITABLE count that flows to the bid's vcq (default = the load's full count, lowerable to a
  // partial) and a per-TRUCK cost label. A PMT load gets the same control READ-ONLY (tonnage fixed
  // by the load, never wired) and a per-METRIC-TONNE cost label. The retired approach (danger banner
  // + "I confirm" checkbox) must be GONE, and none of this may leak onto a single-unit load.
  // ---------------------------------------------------------------------------------------
  console.log('\n4. the multi-unit count control + per-unit cost label render (trucks editable, PMT read-only)');

  const mvHtml = (await get(base, `/price/${publicSeg(mvReq)}`)).body;
  const mvHtmlOnly = mvHtml.replace(/<script[\s\S]*?<\/script>/g, '');
  // (a) TRUCK: a full-width joined count control ships in server-rendered HTML (not JS-dependent).
  ok(/class="mvfield"/.test(mvHtmlOnly), 'truck load: the full-width count control (.mvfield) ships in the HTML');
  ok(/How many trucks to bid for/.test(mvHtmlOnly), 'truck load: the control is labelled "How many trucks to bid for"');
  // (b) TRUCK: the count input is EDITABLE, posts as vehicle_count, defaults to the full count (2),
  //     and is capped at the load's total (max=2) so the desk can only lower it, never over-bid.
  ok(/<input[^>]*id="vehicle_count"[^>]*\bname="vehicle_count"/.test(mvHtmlOnly),
    'truck load: the count input is editable and posts as vehicle_count');
  ok(/id="vehicle_count"[^>]*\bvalue="2"/.test(mvHtmlOnly) && /id="vehicle_count"[^>]*\bmax="2"/.test(mvHtmlOnly),
    'truck load: the count defaults to the full count (2) and is capped at the load total (max=2)');
  ok(/\/ 2 trucks<\/span>/.test(mvHtmlOnly), 'truck load: the fixed total reads "/ 2 trucks"');
  // (c) TRUCK: the cost label is the clean per-TRUCK string (no "same as SuperProcure" / extra text).
  ok(/Your cost PER TRUCK \(Rs\)/.test(mvHtmlOnly), 'truck load: the cost label is "Your cost PER TRUCK (Rs)"');
  ok(!/PER VEHICLE|this load needs|same as SuperProcure/i.test(mvHtmlOnly),
    'truck load: no per-vehicle / "this load needs" / "same as SuperProcure" wording');
  // (d) the retired approach is GONE: no danger banner, no confirm checkbox, no confirm JS.
  ok(!/class="mvbanner"|id="mvConfirm"|The bot will bid for|I confirm this load needs|mvConfirmed/.test(mvHtml),
    'the retired danger banner + "I confirm" checkbox + mvConfirmed guard are gone entirely');
  // (e) NO helper/explanatory text between the count control and the cost label - self-explanatory.
  const between = (mvHtmlOnly.split('class="mvtot"')[1] || '').split('for="cost"')[0] || '';
  ok(!/<p\b/.test(between), 'truck load: no helper <p> text sits between the count control and the cost label');
  // (f) the editable count actually FLOWS to the bid: a capture POST with vehicle_count=1 lowers the
  //     stored count (price.bidVehicleCount) that armFromRequest sends on as vcq.
  const capReq = await requests.createForLoad(load({ id: 'L-MV-CAP', units: 3, quoteType: 'FTL' }), { deadlineAt: Date.now() + 18 * 60_000 });
  await postForm(base, `/price/${publicSeg(capReq)}`, { cost: '48000', vehicle_count: '1' });
  const capStored = await requests.getByToken(capReq.id);
  ok(capStored && capStored.price && capStored.price.bidVehicleCount === 1,
    'truck load: a capture with vehicle_count=1 stores price.bidVehicleCount=1 (the partial the engine bids as vcq)');
  // (g) server-side validation rejects an over-total count (cannot bid for more trucks than the load needs).
  const overReq = await requests.createForLoad(load({ id: 'L-MV-OVER', units: 2, quoteType: 'FTL' }), { deadlineAt: Date.now() + 18 * 60_000 });
  const overRes = await postForm(base, `/price/${publicSeg(overReq)}`, { cost: '48000', vehicle_count: '5' });
  const overStored = await requests.getByToken(overReq.id);
  ok(overRes.status >= 400 && (!overStored.price || overStored.status === 'awaiting_price'),
    'truck load: an over-total vehicle_count (5 of 2) is rejected server-side and the load is not armed');

  // (h) PMT: the same control shape, but READ-ONLY and per-METRIC-TONNE, and the count never posts.
  const pmtHtml = (await get(base, `/price/${publicSeg(pmtReq)}`)).body;
  const pmtHtmlOnly = pmtHtml.replace(/<script[\s\S]*?<\/script>/g, '');
  ok(/class="mvfield"/.test(pmtHtmlOnly) && /How many metric tonnes to bid for/.test(pmtHtmlOnly),
    'PMT load: renders the count control labelled "How many metric tonnes to bid for"');
  ok(/id="vehicle_count"[^>]*\bdisabled/.test(pmtHtmlOnly) && !/id="vehicle_count"[^>]*\bname=/.test(pmtHtmlOnly),
    'PMT load: the tonnage is read-only (disabled) and never posts (no name) - not wired to a bid');
  ok(/\/ 22 metric tonnes<\/span>/.test(pmtHtmlOnly), 'PMT load: the fixed total reads "/ 22 metric tonnes"');
  ok(/Your cost PER METRIC TONNE \(Rs\)/.test(pmtHtmlOnly), 'PMT load: the cost label is "Your cost PER METRIC TONNE (Rs)"');
  // The two halves of the per-tonne mechanic must agree, and since the 2026-08-05 wire capture they
  // agree trivially: the DESK ENTERS A RATE (this per-METRIC-TONNE label + the read-only,
  // un-nameable tonnage mean the operator can only type a per-MT rate, never a whole-load total) and
  // the ENGINE SENDS THAT SAME RATE, unconverted - SuperProcure applies the tonnage itself (see
  // test-adapter-wire check 9 + test-pmt-floor). The displayed tonnage is therefore DISPLAY ONLY; it
  // is not a multiplier anywhere. Pin that the page never invites a total: no "per truck", no
  // "total (Rs)" cost label on a PMT load.
  ok(!/Your cost PER TRUCK \(Rs\)/.test(pmtHtmlOnly) && !/Your cost \(Rs\)/.test(pmtHtmlOnly),
    'PMT load: the cost label is per-MT ONLY - never a per-truck or bare-total label that would invite a total instead of a rate');

  // (h2) THE TRUCK COMMITMENT, stated before a cost is entered.
  // A PMT bid sends vcq:-1 and SuperProcure derives the vehicle count from the LOAD - the 2026-08-05
  // capture on 23828313 sent -1 and SP recorded bidVehicleCount 2. So a PMT bid commits BRL to the
  // load's FULL truck count, and the read-only control above says only "30 / 30 metric tonnes",
  // which never mentions trucks at all. The desk cannot lower the count on a PMT load (no wire field
  // exists for a partial tonnage), so the only honest posture is to SHOW what is being committed to.
  // This is the surface that replaced the deleted PMT_QUANTITY refusal: the split load bids, but it
  // is not a silent commitment. Three states, and every one says something - "no line" would be
  // indistinguishable from "one truck".
  const splitHtml = (await get(base, `/price/${publicSeg(pmtSplitReq)}`)).body.replace(/<script[\s\S]*?<\/script>/g, '');
  ok(/id="pmtCommit"/.test(splitHtml) && /commits to all 2 trucks on this load/.test(splitHtml),
    'PMT split load: the form states the bid commits to all 2 trucks');
  ok(/\(30 metric tonnes, 15 metric tonnes each\)/.test(splitHtml),
    'PMT split load: and states the total tonnage and the per-truck tonnage SuperProcure charges on');
  ok(/cannot bid for part of the load/.test(splitHtml),
    'PMT split load: and says the count cannot be lowered (there is no partial-tonnage bid shape)');

  const oneHtml = (await get(base, `/price/${publicSeg(pmtSingleReq)}`)).body.replace(/<script[\s\S]*?<\/script>/g, '');
  ok(/id="pmtCommit"/.test(oneHtml) && /on 1 truck/.test(oneHtml) && !/commits to all/.test(oneHtml),
    'PMT single-truck load: the form says 1 truck, without the multi-truck commitment wording');

  // The state that matters most: SuperProcure's own figures do NOT settle the truck count. This
  // fixture carries no LoadRules AND its 22/16 ratio is not a whole number of trucks, so neither the
  // snapshot nor the page-side re-derivation can produce a count - which is the real shape of "we do
  // not know", not an artificial one. The page must say so rather than substitute 1, which is exactly
  // the assumption that made the engine's read-back oracle fire on every correct split bid.
  ok(/id="pmtCommit"/.test(pmtHtmlOnly) && /works out how many trucks/.test(pmtHtmlOnly),
    'PMT load with no derivable truck count: the form says SuperProcure decides the count - it never claims 1');
  ok(!/commits to all/.test(pmtHtmlOnly) && !/on 1 truck/.test(pmtHtmlOnly),
    'PMT load with no derivable truck count: and asserts no count it cannot prove');

  // FTL is untouched: the commitment line is per-tonne only, and the truck path keeps its editable
  // count as the human read of the count (it must not grow a second, contradictory sentence).
  ok(!/id="pmtCommit"/.test(mvHtmlOnly), 'a TRUCK multi-vehicle load renders no per-tonne commitment line');

  // (h3) THE UNIT COMES OFF THE LOAD, NEVER OFF A HARDCODED WORD.
  // fmtWeight exists because a hardcoded "MT" suffix once mislabeled KG loads ~1000x too large. The
  // commitment line quotes the same `weight` field the load card renders through fmtWeight, so if this
  // line hardcodes tonnes the SAME PAGE states two different units for one number.
  // Strip BOTH <script> and <style>, same as check (i) below: the .mvfield CSS carries a source
  // comment that literally reads "/ N trucks|metric tonnes", and matching that would make this
  // assertion pass or fail on a comment rather than on anything the desk can read.
  const kgHtml = (await get(base, `/price/${publicSeg(pmtKgReq)}`)).body
    .replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  // Named reversal, A057 (price-page gate): with SP_PMT_BID=1 the engine still refuses a per-tonne load
  // that is not in MT, or that carries a shipper ceiling, and the page now refuses it before a cost
  // field is drawn, from the same assertRulesSupported the engine applies. The fixtures below that are
  // meant to be biddable carry unit 'MT', as every real snapshot does (deriveLoadRules sets it).
  // A KG-quoted per-tonne load is one of those: it now gets the will-not-bid card instead of a cost
  // form. These checks used to pin the KG commitment line and cost label on that form.
  ok(/We will not bid this load/.test(kgHtml) && /bid loads priced this way yet/.test(kgHtml),
    'KG-quoted PMT load: the engine refuses it, so the page shows the will-not-bid card');
  ok(!/metric tonnes/.test(kgHtml),
    'KG-quoted PMT load: and no visible text says "metric tonnes" anywhere - that is the ~1000x mislabel fmtWeight exists to prevent');
  ok(!/Your cost PER/.test(kgHtml) && !/id="cost"/.test(kgHtml),
    'KG-quoted PMT load: no cost field is drawn for a rate the engine would never bid');
  // The load card renders `weight` (SuperProcure's per-vehicle "Qty/Vehicle"), so fmtWeight prints
  // the PER-TRUCK figure - the same 4500 the commitment line quotes, in the same unit. That agreement
  // is the whole point: before this fix the card said "4500 KG" while the new line said "4500 metric
  // tonnes" about the identical field.
  ok(/4500 KG/.test(kgHtml),
    'KG-quoted PMT load: the load card renders fmtWeight\'s "4500 KG" for the same field the commitment line quotes - the two surfaces agree');

  // (h4) A SNAPSHOT PREDATING pmtVehicleCount STILL GETS A COUNT, because this page holds the load.
  // The persisted LoadRules cannot be healed for this field (it stores neither vehicleCount nor
  // weight), so a page that trusted only the snapshot would tell the desk "SuperProcure works out how
  // many trucks" about a load whose own figures say 2 - understating the commitment on exactly the
  // split loads this whole feature was built to stop hiding.
  const staleHtml = (await get(base, `/price/${publicSeg(pmtStaleReq)}`)).body.replace(/<script[\s\S]*?<\/script>/g, '');
  ok(/commits to all 2 trucks on this load/.test(staleHtml),
    'PMT load whose snapshot predates pmtVehicleCount: the page re-derives the count from the load itself');
  ok(!/works out how many trucks/.test(staleHtml),
    'PMT load whose snapshot predates pmtVehicleCount: and does NOT fall back to "the count is unknown"');

  // (h5) THE THREE COMMITMENT STATES, pinned as a DECISION rather than as a regex over HTML.
  // This is a money-commitment sentence; it was previously only reachable through a full page render,
  // which is why a wrong unit in it was invisible to every test. Exported for exactly this.
  {
    const { pmtCommitmentText } = require('../src/web/server');
    const t = pmtCommitmentText;
    ok(/^This bid is for the whole load \(30 metric tonnes\)\. SuperProcure works out how many trucks/.test(t(null, 30, 15, 'metric tonnes')),
      'pmtCommitmentText: an unknown count says SuperProcure decides it, and never claims 1');
    ok(t(1, 18, 18, 'metric tonnes').includes('on 1 truck') && !t(1, 18, 18, 'metric tonnes').includes('commits to all'),
      'pmtCommitmentText: exactly one truck reads as one truck, without the multi-truck wording');
    ok(t(2, 30, 15, 'metric tonnes').includes('commits to all 2 trucks') && t(2, 30, 15, 'metric tonnes').includes('(30 metric tonnes, 15 metric tonnes each)'),
      'pmtCommitmentText: a split names the count, the total and the per-truck quantity');
    ok(t(2, 9000, 4500, 'kilograms').includes('(9000 kilograms, 4500 kilograms each)') && !/tonne/.test(t(2, 9000, 4500, 'kilograms')),
      'pmtCommitmentText: the unit word is a parameter - it holds no unit assumption of its own');
    ok(!/undefined|null|NaN/.test(t(null, null, null, 'metric tonnes') + t(2, null, null, 'metric tonnes') + t(1, null, null, 'metric tonnes')),
      'pmtCommitmentText: a missing quantity is omitted, never rendered as undefined/null to the desk');
    ok(t(2, 30, null, 'metric tonnes').includes('(30 metric tonnes)') && !t(2, 30, null, 'metric tonnes').includes('each'),
      'pmtCommitmentText: a missing per-truck figure drops that clause rather than inventing one');
  }

  // (i) a SINGLE-unit load renders no control and the plain cost label - byte-identical prior form.
  //     Strip BOTH <script> and <style> so the always-present .mvfield CSS rule and guard JS (a no-op
  //     when the control is absent) are not mistaken for the rendered form.
  const singleHtml = (await get(base, `/price/${publicSeg(openReq)}`)).body;
  const singleRendered = singleHtml.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  ok(!/class="mvfield"|id="vehicle_count"|to bid for/.test(singleRendered) && /Your cost \(Rs\)/.test(singleRendered),
    'a single-unit load renders no count control and keeps the plain "Your cost (Rs)" label (unchanged form)');

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
