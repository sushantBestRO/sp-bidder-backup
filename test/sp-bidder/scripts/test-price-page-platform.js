'use strict';
/**
 * What the /price desk page tells someone about the PORTAL a load came from, before they type.
 *
 * The desk works two portals from one worklist and the second one is not the first with a different
 * logo: its auctions extend with no ceiling anyone has found, and some of its enquiries cannot be
 * bid at all. None of that was on the page, and the close-type badge actively said the wrong thing -
 * "Soft - limited" is SuperProcure's bounded anti-snipe window, not an auction that ran 22 rounds
 * and closed two hours late. (A per-enquiry revision-budget card used to render here too; the desk
 * decided it was not needed - "that's understood, no need to alert them" - and it was removed. This
 * file still proves the card stays gone on every portal, which is the regression that matters now.)
 *
 * The rule every case here defends: never ask the desk for a number the system will not use. A
 * previous attempt at this integration took a real cost, discarded it, and then filed the load as
 * unpriced - so a refusal has to arrive BEFORE the cost field, not at the write.
 *
 * Every fact asserted is read from a real adapter's capabilities(), never hand-copied into this
 * file, so a declaration that changes fails here rather than drifting silently away from the page.
 *
 * Parses the SHIPPED bytes over real HTTP, the same reasoning as test-price-page-close-model.js:
 * the labels are assembled inside template literals and a source read cannot catch a rendering
 * mistake.
 *
 * ORDER IS LOAD-BEARING. Section A renders SuperProcure pages while ONE portal is running, which is
 * the production shape today; the second stack is registered only afterwards. A test that pushed it
 * first could never tell "unchanged" from "changed back".
 *
 *   node scripts/test-price-page-platform.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-price-platform-'));

const http = require('http');
const { app, requests, stacks } = require('../src/web/server');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

function req(method, url, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

const GC_ACCOUNT = 'gocomet-primary';
const SOFT_CAPPED = 'Soft - limited';
const SOFT_UNCAPPED = 'Soft - unlimited';
/** The cost field and the form that carries it - the thing a refusal must remove, not merely warn beside. */
const hasCostField = (html) => html.includes('id="cost"') && html.includes('id="mainForm"');

/**
 * A stack the server's own stackForRequest / portalFactsFor lookups will land on, wrapped around a
 * REAL GoCometAdapter so every capability under test comes from the shipped declaration. Only the
 * engine is a stub: the page reads `engine.caps` and `engine.planPreview`, and booting a real engine
 * would drag in a scheduler and a discovery poller that have nothing to do with rendering.
 */
function pushGoCometStack(bidEnabled) {
  const adapter = new GoCometAdapter({ token: null, bidEnabled });
  const caps = adapter.capabilities();
  const stack = {
    account: { accountId: GC_ACCOUNT, label: 'GoComet' },
    tag: { accountId: GC_ACCOUNT, label: 'GoComet' },
    platformKey: 'gocomet',
    adapter,
    engine: {
      caps,
      snapshot: () => [],
      planPreview: () => ({ ladder: [13000, 12000, 11000], floor: 11000, rungCount: 3 }),
    },
  };
  const at = stacks.findIndex((s) => s.account && s.account.accountId === GC_ACCOUNT);
  if (at >= 0) stacks[at] = stack; else stacks.push(stack);
  return caps;
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now();
  let seq = 0;

  const spLoad = (over = {}) => ({
    id: `SP-${++seq}`, lane: { origin: 'Khopoli', destination: 'Keeranur' },
    equipment: 'Trailer', units: 1, quoteType: 'FTL', companyName: 'Havells India',
    closesAt: now + 20 * 60_000, startsAt: now - 60_000, status: 'live',
    softClose: true, closeModelKnown: true, ...over,
  });
  const gcLoad = (over = {}) => ({
    id: `GC-${++seq}`, lane: { origin: 'Chikhli', destination: 'Alwar' },
    equipment: '40FT Truck', units: 1, quoteType: 'FTL', companyName: 'Waaree Energies',
    closesAt: now + 20 * 60_000, startsAt: now - 60_000, status: 'live',
    softClose: true, closeModelKnown: true, cargoLines: 1,
    account: { accountId: GC_ACCOUNT, label: 'GoComet' }, ...over,
  });
  const page = async (load, opts = {}) => {
    const r = await requests.createForLoad(load, { deadlineAt: now + 18 * 60_000, ...opts });
    const res = await req('GET', `${base}/price/${r.id}`);
    return { r, status: res.status, html: res.text };
  };

  // =======================================================================================
  // A. SuperProcure, ONE portal running - the production shape. Nothing new may appear here.
  // =======================================================================================
  console.log('\nA. a SuperProcure load on a single-portal box is unchanged');
  {
    const { html, status } = await page(spLoad());
    ok(status === 200, `SP price page renders (status ${status})`);
    ok(hasCostField(html), 'SP: the cost field is there');
    // The portal name now rides ON the identifier ("GoComet #GC-1") instead of in its own pill, so
    // this asserts on the NAME rather than on the retired element - a class-name check would pass
    // for free forever now that the class is gone, which is the opposite of what this line is for.
    ok(!html.includes('SuperProcure #') && !html.includes('class="badge portal"'),
      'SP: NO portal name on the identifier - with one portal running it names the only thing it could name');
    ok(html.includes(SOFT_CAPPED) && !html.includes(SOFT_UNCAPPED),
      'SP: the close badge still reads "Soft - limited" - SuperProcure declares no extension ceiling either way');
    ok(!/bids total for this load/.test(html),
      'SP: no revision-budget line - the mock adapter declares revisionLimit 6, and a budget alone is not the fact');
    ok(!html.includes('id="wontBid"'), 'SP: no refusal card');
    // Asserted at the DECLARATION rather than by searching the page for the phrase: the ladder line
    // is written by the inline script, so the phrase reaching the desk is whatever PVLEAD holds.
    ok(html.includes('var PVLEAD="Prices that will go out"'), 'SP: the ladder line keeps its present tense');
  }

  // =======================================================================================
  // B. GoComet, live for bidding. The two facts a person needs before typing a number.
  // =======================================================================================
  console.log('\nB. a GoComet load states its portal and its close model, never a revision budget');
  const caps = pushGoCometStack(true);
  ok(caps.platformLabel === 'GoComet', 'the adapter declares its own display label');
  ok(caps.revisionLimit === 3, 'the adapter declares a revision limit of 3');
  ok(Object.prototype.hasOwnProperty.call(caps, 'extensionCeiling') && caps.extensionCeiling === null,
    'the adapter declares extensionCeiling null - "no cap exists", not "cap unknown"');
  {
    const { html, status } = await page(gcLoad(), { platformKey: 'gocomet' });
    ok(status === 200, `GoComet price page renders (status ${status})`);
    const header = /<div class="brand">([\s\S]*?)<\/div>\s*<h1/.exec(html);
    // BOUND TO THE NUMBER, not beside it. The desk read a bare "#2608115VVB" as our own reference
    // and asked which number it was; the portal's name now prefixes the identifier so the answer is
    // in the same string. One pill fewer in a corner that held three, and the close-type badge -
    // the one that changes how the load is priced - keeps its own line.
    ok(!!header && header[1].includes(`<span class="loadno">${caps.platformLabel} #`),
      'the portal name prefixes the load identifier in the header, so which number this is cannot be misread');
    ok(!!header && !header[1].includes('class="badge portal"'),
      'and the separate portal pill is gone - the name is stated once, not twice');
    ok(html.includes(SOFT_UNCAPPED) && !html.includes(SOFT_CAPPED),
      'the close badge reads "Soft - unlimited" and never borrows SuperProcure\'s bounded wording');
    // Removed on product-owner call ("i don't think that yellow flag is required... that's
    // understood, no need to alert them") even though the adapter still declares a revision limit
    // of 3 and an uncapped extension - the exact pair that used to gate the card on.
    ok(!/bids total for this load/.test(html) && !html.includes(`Only ${caps.revisionLimit} bids on this load`),
      'THE POINT: no revision-budget card, even though the capability pair that used to gate it on is present');
    ok(hasCostField(html), 'a biddable GoComet load still asks for a cost');
    ok(!html.includes('id="wontBid"'), 'a biddable GoComet load carries no refusal card');
  }

  // =======================================================================================
  // C. Several truck types: PRICED, with every type on screen before the number is.
  //
  // This section asserted the opposite until 2026-08-19, when the arithmetic behind the refusal
  // was shown to be wrong: `price` is per UNIT and GoComet multiplies each line by its own units
  // and sums, so one rate on every line is a uniform per-truck rate, not an N-fold. The rule the
  // section defends is unchanged - never ask the desk for a number the system will not use - but
  // the system now uses this one, and the new hazard is the mirror image of the old: a rate typed
  // for the truck the desk can see, applied to a truck they cannot.
  // =======================================================================================
  console.log('\nC. a several-truck-type load is priced, and the page shows every type');
  {
    const load = gcLoad({
      cargoLines: 2, units: 6, equipment: '5 x 40 ft, 25 T + 1 x 20 ft ODC, 10 T',
      cargoTypes: [{ label: '40 ft, 25 T', count: 5 }, { label: '20 ft ODC, 10 T', count: 1 }],
    });
    const { r, html, status } = await page(load, { platformKey: 'gocomet' });
    ok(status === 200, `multi-truck-type page renders (status ${status})`);
    ok(!html.includes('id="wontBid"'), 'no refusal card - the load is biddable now');
    ok(hasCostField(html), 'the cost field is there');
    ok(html.includes('2 truck types on this load'), 'the page says how many truck types the load carries');
    ok(html.includes('40 ft, 25 T') && html.includes('20 ft ODC, 10 T'),
      'THE POINT: BOTH types are named, not just the first');
    ok(/&times;5/.test(html) && /&times;1/.test(html), 'each type carries its OWN count, which is what differs between them');
    // This fixture's types carry no `match` token (the join key the adapter routes a per-type rate
    // on), so the page falls back to ONE rate with the types listed above it - which is what a
    // request snapshotted before that field existed must keep doing.
    ok(!/cost_type_0/.test(html), 'with no join key on the types, no per-type rate inputs are offered');
    ok(html.includes('id="mvTotal"'), 'the running total element is on the page for the script to fill');
    // The prose that explained the portal's arithmetic is gone: the running total shows it, and a
    // sentence restating it beside the number is the noise the Director asked to have cut.
    ok(!/One rate covers every type above/.test(html) && !html.includes(`${caps.platformLabel} multiplies it by each type`),
      'and the arithmetic is shown rather than narrated');

    // The COST IS ASKED FOR, which is the whole reversal: the multi-cargo branch of
    // loadWillNotBid no longer fires, so nothing refuses this submit for having several truck
    // types. (A raw POST here still 409s on the unrelated soft-close scope gate every GoComet
    // fixture in this file trips - which is exactly why the assertion is on the REFUSAL BEING
    // GONE rather than on a 200 that would be measuring a different rule.)
    const posted = await req('POST', `${base}/price/${r.id}`, form({ cost: '25000' }));
    ok(!/cargo lines and one rate cannot be split/.test(posted.text),
      'a raw cost POST is no longer refused for carrying several truck types');

    const pv = await req('GET', `${base}/price/${r.id}/preview?cost=25000`);
    ok(pv.status === 200 && pv.json && !pv.json.willNotBid, 'the preview promises a ladder rather than a refusal');
    ok(pv.json && Array.isArray(pv.json.ladder) && pv.json.ladder.length > 0, 'and returns one');
  }

  // =======================================================================================
  // C2. THE SAME LOAD, WITH THE TYPES CARRYING THEIR JOIN KEY: one cost input per truck type.
  //     A 40 ft 25 T and a 20 ft ODC 10 T are not worth the same per truck, so one blended rate
  //     sits below cost on the dearer type. This is the form that closes that.
  // =======================================================================================
  console.log('\nC2. per-truck-type cost inputs when the types can be routed to freight lines');
  {
    const load = gcLoad({
      cargoLines: 2, units: 6, equipment: '5 x 40 ft, 25 T + 1 x 20 ft ODC, 10 T',
      cargoTypes: [
        { label: '40 ft, 25 T', count: 5, match: '40ftlxwxh40x8x8825tons' },
        { label: '20 ft ODC, 10 T', count: 1, match: '20ftodclxwxh20x8x8810ton' },
      ],
    });
    const { html, status } = await page(load, { platformKey: 'gocomet' });
    ok(status === 200, `per-type page renders (status ${status})`);
    ok(/name="cost_type_0"/.test(html) && /name="cost_type_1"/.test(html),
      'ONE cost input per truck type, keyed by the index the page rendered them in');
    ok(!/name="cost_type_2"/.test(html), 'and no input for a type the load does not carry');
    ok(/aria-label="Your cost per truck for 40 ft, 25 T"/.test(html)
      && /aria-label="Your cost per truck for 20 ft ODC, 10 T"/.test(html),
      'each input names ITS OWN truck type, so a rate cannot be typed against the wrong one');
    ok(/data-count="5"/.test(html) && /data-count="1"/.test(html),
      'each row carries its own unit count, which is what the line total and the blend are built from');
    ok(/<input id="cost" name="cost" type="hidden"/.test(html),
      'the single cost field becomes a HIDDEN blended cost - the band, ladder and ceiling keep one number to read');
    ok(!/>Your cost PER TRUCK \(Rs\)<\/label>/.test(html),
      'and the single per-truck label is gone, so the desk is never asked for one rate and N rates at once');
    ok(/class="mvtt"/.test(html) && /class="mvsumrow"/.test(html) && /id="mvTotal"/.test(html),
      'a per-type line total and a whole-load total are both on the page');
  }
  {
    // The refusal CARD is not deleted, only unreachable on this portal: it is gated on the
    // capability, so a portal that declares it cannot price a several-line load still refuses
    // before the cost field. Asserted against a stack whose caps say so, because that contract is
    // what stops the card being quietly dropped along with the GoComet refusal it was written for.
    const gc = stacks.find((s) => s.account && s.account.accountId === GC_ACCOUNT);
    const realCaps = gc.engine.caps;
    gc.engine.caps = Object.assign({}, realCaps, { multiCargoBidSupported: false });
    try {
      const { r, html } = await page(gcLoad({ cargoLines: 2 }), { platformKey: 'gocomet' });
      ok(html.includes('id="wontBid"'), 'a portal declaring multiCargoBidSupported false still refuses at render');
      ok(html.includes('2 separate cargo lines and one rate cannot be split across them'),
        'naming the count and the reason');
      ok(!hasCostField(html), 'and no cost field is offered for a rate that could never be used');
      const posted = await req('POST', `${base}/price/${r.id}`, form({ cost: '25000' }));
      ok(posted.status === 409, `a raw cost POST is still refused there (status ${posted.status})`);
    } finally {
      gc.engine.caps = realCaps;
    }
    ok(realCaps.multiCargoBidSupported === true,
      'and the REAL GoComet adapter declares it CAN price one - read from capabilities(), never hand-copied');
  }

  // =======================================================================================
  // D. Portal not live for bidding: the cost IS wanted, and the page says why it waits.
  // =======================================================================================
  console.log('\nD. a portal that cannot bid yet keeps the cost and says so');
  const offCaps = pushGoCometStack(false);
  ok(offCaps.biddingEnabled === false, 'the adapter declares biddingEnabled false with its write gate off');
  {
    const { html } = await page(gcLoad(), { platformKey: 'gocomet' });
    ok(html.includes('id="wontBid"'), 'the refusal card renders');
    ok(html.includes('This portal is not live for bidding yet, so we will not bid this load'),
      'the page uses the arm seam\'s own sentence for the same fact');
    ok(html.includes('your price is kept and will be used when this portal goes live'),
      'the page promises what the arm seam already promises: the number is kept and used later');
    ok(hasCostField(html),
      'THE COST FIELD STAYS - this rate is used, just not yet, and refusing to take it would discard real work');
    ok(html.includes('var PVLEAD="Prices we will send when this portal goes live"') && !html.includes('Prices that will go out'),
      'the ladder line is re-tensed rather than promising prices that are not going out today');
  }

  // =======================================================================================
  // E. A request the SYSTEM stopped must not read as a colleague stopping it.
  // =======================================================================================
  console.log('\nE. a stopped request renders its own reason');
  {
    const r = await requests.createForLoad(gcLoad(), { deadlineAt: now + 18 * 60_000, platformKey: 'gocomet' });
    await requests.capture(r.id, { cost: 25_000 });
    await requests.holdUnbiddable(r.id, 'platform_bidding_disabled');
    const res = await req('GET', `${base}/price/${r.id}`);
    ok(res.status === 200, `the stopped request renders (status ${res.status})`);
    ok(!res.text.includes('An operator paused bidding on this load'),
      'THE DEFECT: a system hold no longer reads as an operator pausing the load');
    ok(res.text.includes('Not bidding this load'), 'the page names the state it is actually in');
    ok(res.text.includes('This portal is not live for bidding yet, so we will not bid this load'),
      'the held reason on the record is what the page states');
    ok(res.text.includes('Your cost is saved'), 'the desk is told their work survived');

    // THE SECOND SITE. An open form finds out through the poller, never through a page render, and
    // it announced every 'stopped' as an operator pause. Fixing one site and not the other leaves
    // the wrong sentence on the only surface a desk with the page still open would actually see.
    const st = await req('GET', `${base}/price/${r.id}/state`);
    ok(st.json && st.json.heldReason === 'platform_bidding_disabled',
      'the poller endpoint carries the held reason, not just the status');

    // An operator stop still reads as an operator stop - the two must stay distinguishable.
    const r2 = await requests.createForLoad(gcLoad(), { deadlineAt: now + 18 * 60_000, platformKey: 'gocomet' });
    await requests.capture(r2.id, { cost: 25_000 });
    await requests.stop(r2.id);
    const res2 = await req('GET', `${base}/price/${r2.id}`);
    ok(res2.text.includes('An operator paused bidding on this load'),
      'an operator stop still says an operator did it - heldReason is the discriminator, not the status');
    const st2 = await req('GET', `${base}/price/${r2.id}/state`);
    ok(st2.json && st2.json.heldReason === null,
      'an operator stop carries no held reason, so the poller keeps the operator wording for it');
  }

  // =======================================================================================
  // F. With two portals running, EVERY page carries its portal - including SuperProcure's.
  // =======================================================================================
  console.log('\nF. the label goes on both portals or neither');
  {
    const { html } = await page(spLoad());
    ok(html.includes('<span class="loadno">SuperProcure #'),
      'the SuperProcure page names its own portal on the identifier once a second portal is running');
    ok(html.includes(SOFT_CAPPED) && !html.includes(SOFT_UNCAPPED),
      'the SuperProcure close badge is unaffected by the other portal\'s declarations');
    ok(!/bids total for this load/.test(html), 'and it still states no revision budget');
    ok(hasCostField(html), 'and it still asks for a cost');
  }

  server.close();

  // COMPLETION SENTINEL. run-tests.js grades a file by EXIT STATUS only, so a file that returns
  // early - an unref'd timer, an early return, a swallowed rejection - exits 0 having asserted
  // nothing and is scored a pass. Pinning the count makes a vacuous green impossible.
  const EXPECTED_CHECKS = 60;
  const ran = pass + fail;
  if (ran !== EXPECTED_CHECKS) {
    console.error(`  FAIL - completion sentinel: ran ${ran} checks, expected ${EXPECTED_CHECKS} (a check was skipped or added without updating EXPECTED_CHECKS)`);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  console.log(`\n${pass} passed, ${fail} failed (${ran}/${EXPECTED_CHECKS} checks reached the sentinel)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
