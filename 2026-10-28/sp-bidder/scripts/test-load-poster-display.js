'use strict';
/**
 * LOAD POSTER on the pricing desk page.
 *
 * The person who posted a load (name + mobile) already rides the load LIST response the
 * discovery loop calls every cycle - branchUserName / branchUserMobile / loadCreatedBy on
 * /sp/loads/v4 - but _mapLoad never read them, so the desk had no way to ring the shipper-side
 * contact about a load it was pricing. This pins the whole path: raw SP fields -> mapped load ->
 * durable PriceRequest snapshot -> a "Posted by" cell on /price/<token> with a tel: link, and (since
 * 2026-07-28) a "Posted by" line on the WON WhatsApp receipt, where it is the number BRL's own manager
 * rings to get the vehicle placed. Sections 11-13 cover that second surface; the engine carry path
 * that gets the poster from the arm to the outcome event lives in test-won-poster-carry.js.
 *
 * The half that matters more is what must NOT render. SuperProcure posts some loads under a
 * PLACEHOLDER identity - branchUserName "System" with a 1000000000-class mobile (observed live
 * on system-posted loads) - which is the same hazard class as its year-2100 placeholder close times: it is
 * perfectly well-formed, so only a shape check catches it. Showing it would send the desk
 * dialling a number that belongs to nobody. Every guard below fails CLOSED to no row at all,
 * never to a stranded "Posted by" label with nothing after it.
 *
 * EVERY NAME AND NUMBER BELOW IS FABRICATED. The DEMO POSTER NAME / 9000012345 pair follows the
 * repo-wide fake-contact convention (server.js seedDemoPriceRequests, scripts/seed-*-demo.js,
 * scripts/fixtures/maytapi-getgroups.sample.js) - no real shipper contact appears in this file.
 *
 *   node scripts/test-load-poster-display.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const assert = require('assert');
const http = require('http');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { app, store } = require('../src/web/server');
const { PriceRequestStore, publicSeg } = require('../src/pricing/priceRequests');
const { renderMessage } = require('../src/notify/waTemplates');
const { toNotification } = require('../src/notify/engineAlerts');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

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

/** Every inline <script> body on the page, in document order (same idiom as test-price-page-js.js). */
function inlineScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) if (m[1].trim()) out.push(m[1]);
  return out;
}
/** `new Function` compiles without executing - catches a SyntaxError without needing a DOM. */
const parses = (src) => { try { new Function(src); return null; } catch (e) { return e.message; } };

/** A raw /sp/loads/v4 load, shaped as SuperProcure actually sends one. */
const rawLoad = (over = {}) => ({
  id: 90000001,
  companyName: 'Havells India Limited',
  loadingPoints: '',
  vehicleName: '32 Feet',
  vehicleCount: 1,
  weight: 16,
  brancheUnit: 'MT',
  biddingOn: 1,
  biddingCloseTime: new Date(Date.now() + 30 * 60_000).toISOString(),
  branchAuctionExtendTime: '00:00:00',
  ...over,
});

/** A mapped-load shape for the snapshot/render half (mirrors what _mapLoad emits). */
const mappedLoad = (over = {}) => ({
  id: 'L-1',
  lane: { origin: 'Alwar', destination: 'Bhiwandi' },
  companyName: 'Havells India Limited',
  equipment: '32 Feet', units: 1,
  weight: 16, weightUnit: 'MT',
  closesAt: Date.now() + 30 * 60_000,
  softClose: false, closeModelKnown: true,
  ...over,
});

const adapter = () => { const a = new RealSuperProcureAdapter({ token: 't' }); a.account = { carrierId: 2667 }; return a; };

/**
 * A won-alert payload carrying `poster`, for the WhatsApp-render half. Margin is deliberately healthy
 * (12.6% against an 8% floor) so the low-margin warning stays silent and the assertions below read
 * against the plain receipt.
 */
const wonData = (poster) => ({
  oaNo: 'OA-P1', shipperName: 'Havells', branch: 'Alwar', from: 'Pune', to: 'Akola',
  vehicleType: '2 x 22 Feet upto 10 MT', marketRate: '26,000', wonRate: '29,276', marginPct: '12.60',
  minMarginPct: 8, attempts: 1, closeTime: '28-07-2026 11:45 AM', finalRank: 1, poster,
});

(async () => {
  // ---- 1. _mapLoad CAPTURES the poster off the fields the list call already returns ----
  {
    const m = adapter()._mapLoad(rawLoad({
      branchUserName: 'DEMO POSTER NAME',
      branchUserMobile: '9000012345',
      loadCreatedBy: 90001,
      displayPartyDetails: 1,
    }));
    assert.ok(m.poster, 'a real poster is carried onto the mapped load');
    assert.strictEqual(m.poster.name, 'DEMO POSTER NAME', 'the poster name comes straight off branchUserName');
    assert.strictEqual(m.poster.mobile, '9000012345', 'the 10-digit mobile comes straight off branchUserMobile');
    assert.strictEqual(m.poster.createdBy, '90001', 'loadCreatedBy is carried as a string id');

    // whitespace/formatting SP has been seen to add must not defeat the capture
    const spaced = adapter()._mapLoad(rawLoad({ branchUserName: '  DEMO POSTER NAME  ', branchUserMobile: '+91 90000-12345' }));
    assert.strictEqual(spaced.poster.name, 'DEMO POSTER NAME', 'the name is trimmed');
    assert.strictEqual(spaced.poster.mobile, '9000012345', 'punctuation and the country code are stripped to 10 digits');
    ok('_mapLoad captures name + mobile (+ createdBy) off branchUserName/branchUserMobile/loadCreatedBy');
  }

  // ---- 2. the "System" placeholder poster -> null (never displayed) ----
  {
    const sys = adapter()._mapLoad(rawLoad({ id: 90000002, branchUserName: 'System', branchUserMobile: '1000000000' }));
    assert.strictEqual(sys.poster, null, 'the live System-posted shape maps to NO poster');
    for (const v of ['system', ' System ', 'SYSTEM']) {
      assert.strictEqual(adapter()._mapLoad(rawLoad({ branchUserName: v, branchUserMobile: '9000012345' })).poster, null,
        `the System placeholder is caught case/whitespace-insensitively (${JSON.stringify(v)})`);
    }
    // and a genuinely absent poster is null too, not a half-built object
    assert.strictEqual(adapter()._mapLoad(rawLoad()).poster, null, 'a load with no poster fields at all maps to null');
    assert.strictEqual(adapter()._mapLoad(rawLoad({ branchUserName: '   ' })).poster, null, 'a blank name is not a poster');
    ok('the System placeholder poster maps to null (case/whitespace-insensitive); absent/blank -> null');
  }

  // ---- 3. a PLACEHOLDER MOBILE discredits the whole row, even with a real-looking name ----
  {
    for (const bad of ['1000000000', '0000000000', '1111111111', '9999999999']) {
      assert.strictEqual(adapter()._mapLoad(rawLoad({ branchUserName: 'DEMO POSTER NAME', branchUserMobile: bad })).poster, null,
        `a ${bad} placeholder mobile fails closed to no poster at all`);
    }
    // a real mobile that merely LOOKS repetitive is not a placeholder - the guard must not overreach
    const real = adapter()._mapLoad(rawLoad({ branchUserName: 'DEMO POSTER NAME', branchUserMobile: '9111111111' }));
    assert.ok(real.poster && real.poster.mobile === '9111111111', 'a real mobile with a repeated tail is still carried');
    // a name with an unusable-LENGTH number keeps the name (who to ask for) but drops the number
    const shortNum = adapter()._mapLoad(rawLoad({ branchUserName: 'DEMO POSTER NAME', branchUserMobile: '12345' }));
    assert.ok(shortNum.poster && shortNum.poster.name === 'DEMO POSTER NAME', 'a short number does not discard the name');
    assert.strictEqual(shortNum.poster.mobile, null, 'but an unusable-length number is not carried as a dialable mobile');
    ok('placeholder mobiles (all-same-digit / 1000000000) null the whole poster; real numbers survive');
  }

  // ---- 4. an IMPLAUSIBLE mobile never becomes a dialable number, even at exactly 10 digits ----
  {
    // Ten digits is not the rule. normalizePhoneIN (src/model/normalizePhone.js) is the repo's ONE
    // phone rule - an Indian mobile starts 6-9 - and this surface routes through it rather than
    // re-deriving it. '1234567890' is the shape that would otherwise render as a live tel: link
    // under a real person's name. It degrades exactly like the too-short case above: the name still
    // tells the desk who to ask for, there is simply nothing to tap.
    for (const junk of ['1234567890', '01234567890', '0123456789', '5000000001', '+91 1234567890']) {
      const m = adapter()._mapLoad(rawLoad({ branchUserName: 'DEMO POSTER NAME', branchUserMobile: junk }));
      assert.ok(m.poster && m.poster.name === 'DEMO POSTER NAME', `an implausible mobile ${JSON.stringify(junk)} still keeps the name`);
      assert.strictEqual(m.poster.mobile, null, `but ${JSON.stringify(junk)} is never carried as a dialable mobile`);
    }
    // the guard must not over-reach onto the live ranges - every legal Indian first digit survives
    for (const good of ['6000012345', '7000012345', '8000012345', '9000012345']) {
      const m = adapter()._mapLoad(rawLoad({ branchUserName: 'DEMO POSTER NAME', branchUserMobile: good }));
      assert.strictEqual(m.poster.mobile, good, `a valid ${good[0]}-series mobile is carried through`);
    }
    // and every country-coded/trunk-prefixed spelling reduces to the SAME national number, never a
    // different-but-valid one (the truncate-then-validate failure normalizePhoneIN exists to stop)
    for (const eq of ['+91 90000-12345', '09000012345', '00919000012345', '919000012345']) {
      assert.strictEqual(adapter()._mapLoad(rawLoad({ branchUserName: 'DEMO POSTER NAME', branchUserMobile: eq })).poster.mobile,
        '9000012345', `${JSON.stringify(eq)} normalises to the same 10-digit national number`);
    }
    ok('an implausible 10-digit mobile keeps the name but yields no dialable number; 6/7/8/9-series survive');
  }

  // ---- 5. displayPartyDetails present-and-falsy -> null (SP says the shipper hid it) ----
  {
    for (const off of [0, '0', false]) {
      assert.strictEqual(
        adapter()._mapLoad(rawLoad({ branchUserName: 'DEMO POSTER NAME', branchUserMobile: '9000012345', displayPartyDetails: off })).poster,
        null, `displayPartyDetails ${JSON.stringify(off)} hides the poster`);
    }
    // the STRING "0" case is the one a plain truthiness check would leak - pin it explicitly
    const strZero = adapter()._mapLoad(rawLoad({ branchUserName: 'DEMO POSTER NAME', branchUserMobile: '9000012345', displayPartyDetails: '0' }));
    assert.strictEqual(strZero.poster, null, 'a STRING "0" is falsy for this flag (a bare truthiness check would have leaked the name)');
    // ABSENT is not "off" - every live observation carries 1, and older payloads omit it entirely
    const absent = adapter()._mapLoad(rawLoad({ branchUserName: 'DEMO POSTER NAME', branchUserMobile: '9000012345' }));
    assert.ok(absent.poster, 'an ABSENT displayPartyDetails is not treated as off');
    const on = adapter()._mapLoad(rawLoad({ branchUserName: 'DEMO POSTER NAME', branchUserMobile: '9000012345', displayPartyDetails: 1 }));
    assert.ok(on.poster, 'displayPartyDetails 1 shows the poster');
    ok('displayPartyDetails present-and-falsy (0 / "0" / false) hides the poster; absent or 1 shows it');
  }

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const requests = new PriceRequestStore({ store, marginsPct: [12, 8, 6], minMarginPct: 6, platformKey: 'sp' });
  const deadline = () => ({ deadlineAt: Date.now() + 25 * 60_000 });

  // ---- 6. the durable PriceRequest snapshot CARRIES the poster ----
  {
    const withPoster = await requests.createForLoad(
      mappedLoad({ id: 'L-POSTER', poster: { name: 'DEMO POSTER NAME', mobile: '9000012345', createdBy: '90001' } }), deadline());
    const stored = await requests.getByToken(withPoster.id);
    assert.ok(stored.load.poster, 'the snapshot carries the poster');
    assert.strictEqual(stored.load.poster.name, 'DEMO POSTER NAME', 'the snapshotted name survives the store round-trip');
    assert.strictEqual(stored.load.poster.mobile, '9000012345', 'the snapshotted mobile survives the store round-trip');

    const without = await requests.createForLoad(mappedLoad({ id: 'L-NOPOSTER' }), deadline());
    const storedNone = await requests.getByToken(without.id);
    assert.strictEqual(storedNone.load.poster, null, 'a load with no poster snapshots an explicit null, never undefined-by-accident');
    ok('the PriceRequest snapshot carries poster (and stores an explicit null when there is none)');
  }

  // ---- 7. the /price page RENDERS the row, with the number as a tel: link ----
  {
    const req = await requests.createForLoad(
      mappedLoad({ id: 'L-RENDER', poster: { name: 'DEMO POSTER NAME', mobile: '9000012345', createdBy: '90001' } }), deadline());
    const res = await get(base, `/price/${publicSeg(req)}`);
    assert.strictEqual(res.status, 200, 'the price page serves');
    // strip scripts + styles: the row must exist in SERVER-RENDERED HTML, not depend on JS
    const html = res.body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
    assert.ok(/Posted by/.test(html), 'the page names the fact "Posted by" in plain HTML');
    assert.ok(/DEMO POSTER NAME/.test(html), 'the poster name is rendered');
    assert.ok(/href="tel:\+919000012345"/.test(html), 'the mobile is a clickable tel: link with the country code and no spaces');
    assert.ok(/>90000 12345</.test(html), 'the displayed number is grouped 5+5, the way it is read back on a call');
    // the row sits in the SAME facts grid as the other load facts (one markup pattern, not a bolt-on)
    assert.ok(/<div class="scell"><span class="si">[\s\S]*?<span class="sl">Posted by<\/span><span class="sv">/.test(html),
      'the row uses the existing .scell facts-grid markup, like Vehicle/Weight/Distance');
    ok('/price renders a "Posted by" facts-grid row with a tel: link, in server-rendered HTML');
  }

  // ---- 8. NO ROW AT ALL when there is no poster - never a stranded "Posted by" ----
  {
    const req = await requests.createForLoad(mappedLoad({ id: 'L-NOROW' }), deadline());
    const res = await get(base, `/price/${publicSeg(req)}`);
    assert.strictEqual(res.status, 200, 'the poster-less price page still serves normally');
    const html = res.body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
    assert.ok(!/Posted by/.test(html), 'a poster-less load renders NO "Posted by" text anywhere');
    assert.ok(!/href="tel:/.test(html), 'and no tel: link');
    assert.ok(/Your cost \(Rs\)/.test(html), 'the rest of the form is untouched');
    ok('a poster-less load renders no row at all (no stranded label, no empty tel: link)');
  }

  // ---- 9. BACKWARD COMPAT: a record stored before the field existed must not crash or render ----
  {
    // written straight to the store, deliberately WITHOUT a `poster` key anywhere in load{} -
    // exactly the shape of every request captured before this change deployed.
    const legacy = await requests.createForLoad(mappedLoad({ id: 'L-LEGACY' }), deadline());
    const doc = await requests.getByToken(legacy.id);
    delete doc.load.poster;
    await store.putDoc('priceRequests', legacy.id, doc);
    const reread = await requests.getByToken(legacy.id);
    assert.ok(!('poster' in reread.load), 'precondition: the stored record genuinely has no poster key');

    const res = await get(base, `/price/${publicSeg(legacy)}`);
    assert.strictEqual(res.status, 200, 'an old record without the field still serves 200 (no crash)');
    const html = res.body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
    assert.ok(!/Posted by/.test(html), 'an old record renders no poster row');
    assert.ok(/Your cost \(Rs\)/.test(html), 'and the old record still renders a working cost form');

    // a MALFORMED poster (shape drift / hand-edited doc) must also degrade to no row, not throw
    const junkShapes = [{}, { name: '' }, { name: '   ' }, { mobile: '9000012345' }];
    for (let j = 0; j < junkShapes.length; j++) {
      const junk = junkShapes[j];
      const d = await requests.createForLoad(mappedLoad({ id: `L-JUNK-${j}` }), deadline());
      const doc2 = await requests.getByToken(d.id);
      doc2.load.poster = junk;
      await store.putDoc('priceRequests', d.id, doc2);
      const r2 = await get(base, `/price/${publicSeg(d)}`);
      assert.strictEqual(r2.status, 200, `a malformed poster ${JSON.stringify(junk)} does not break the page`);
      assert.ok(!/Posted by/.test(r2.body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')),
        `a malformed poster ${JSON.stringify(junk)} renders no row`);
    }
    ok('old records without the field (and malformed ones) serve fine and render no row');
  }

  // ---- 10. the page's inline JS still PARSES with the row on it (the 362b8a9 class of bug) ----
  {
    const req = await requests.createForLoad(
      // an apostrophe in the NAME is the realistic hostile value here - SP carries real people's
      // names, and this page is assembled inside template literals.
      mappedLoad({ id: 'L-PARSE', poster: { name: "D'SOUZA <script>x</script>", mobile: '9000012345', createdBy: '1' } }), deadline());
    const res = await get(base, `/price/${publicSeg(req)}`);
    const scripts = inlineScripts(res.body);
    assert.ok(scripts.length >= 2, `the price page still ships its inline scripts (${scripts.length})`);
    scripts.forEach((s, i) => {
      const err = parses(s);
      assert.strictEqual(err, null, `inline script #${i + 1} still parses${err ? ` -> ${err}` : ''}`);
    });
    // the hostile name is rendered, but ESCAPED - never as live markup
    assert.ok(/D&#39;SOUZA|D&#x27;SOUZA|D'SOUZA/.test(res.body), 'the name is rendered (escaped) rather than dropped');
    assert.ok(!/<span class="sv">[^<]*<script>/.test(res.body), 'no raw <script> is injected through the poster name');
    assert.ok(/&lt;script&gt;x&lt;\/script&gt;/.test(res.body), 'the injected tag arrives entity-escaped, not as a live element');
    ok('the poster row does not break the page inline JS, and a hostile name is escaped');
  }

  // ---- 11. the WON WhatsApp message names the contact, ABOVE the allotment CTA ----
  {
    // Suyashh's ask (2026-07-28): the won receipt must carry "the manager who posted ... his name and
    // number ... so that our manager can coordinate with them and place the vehicle". The ORDER is the
    // point - the contact has to sit above the allotment instruction it serves, not trail after it.
    const won = renderMessage('won', wonData({ name: 'DEMO POSTER NAME', mobile: '9000012345', createdBy: '90001' }));
    assert.ok(/📞 \*Posted by\* - DEMO POSTER NAME · \+919000012345/.test(won), 'the won message carries "Posted by - <name> · +91<number>"');
    assert.ok(won.indexOf('Posted by') < won.indexOf('Complete the allotment'),
      'the contact sits ABOVE the allotment CTA (you are told who to ring, then told to go allot)');
    // WhatsApp linkifies a bare international number into a tappable call; the 5+5 spacing the /price
    // card uses is exactly what defeats that, so this surface must NOT inherit it.
    assert.ok(!/90000 12345/.test(won) && !/\+91[\s-]/.test(won),
      'the number is NOT spaced 5+5 (nor hyphenated) here - that spacing is what stops WhatsApp linkifying it');
    assert.ok(/\*Posted by\*/.test(won), 'the label reuses the /price card wording ("Posted by"), one vocabulary across surfaces');
    assert.ok(!/\{\{\d+\}\}/.test(won), 'the won message leaves no unfilled placeholders with the new slot in place');
    ok('the won message renders the poster contact above the allotment CTA, tappable and unspaced');
  }

  // ---- 12. the contact line DEGRADES rather than dangling a label or half a number ----
  {
    const none = renderMessage('won', wonData(null));
    assert.ok(!/Posted by/.test(none) && !/📞/.test(none), 'no poster -> no contact line at all (never a stranded label)');
    assert.ok(/Complete the allotment on SuperProcure/.test(none), 'and the rest of the win receipt is untouched');
    // a name with an unusable number still renders: knowing who to ask for is most of the value.
    const nameOnly = renderMessage('won', wonData({ name: 'DEMO POSTER NAME', mobile: null }));
    assert.ok(/📞 \*Posted by\* - DEMO POSTER NAME$/m.test(nameOnly), 'a null mobile keeps the name and prints no number');
    assert.ok(!/\+91/.test(nameOnly), 'and never a bare "+91" with nothing after it');
    // wrong-length digits must never render as a dialable number - the manager would dial it.
    for (const bad of ['900001234', '90000123456', '', '   ', 'not-a-number']) {
      const m = renderMessage('won', wonData({ name: 'DEMO POSTER NAME', mobile: bad }));
      assert.ok(/Posted by\* - DEMO POSTER NAME/.test(m), `a ${JSON.stringify(bad)} mobile still keeps the name`);
      assert.ok(!/\+91/.test(m), `but ${JSON.stringify(bad)} is never rendered as a dialable number`);
    }
    // malformed / hand-edited shapes degrade to no line rather than throwing mid-render.
    for (const junk of [{}, { name: '' }, { name: '   ' }, { mobile: '9000012345' }, 'a string', 42]) {
      const m = renderMessage('won', wonData(junk));
      assert.ok(m && !/Posted by/.test(m), `a malformed poster ${JSON.stringify(junk)} renders no line and does not throw`);
    }
    ok('the contact line degrades cleanly: no poster, name-only, bad digits, and malformed shapes');
  }

  // ---- 13. WON-ONLY: a load we did not win has nothing to coordinate ----
  {
    // A loss/no-bid has no vehicle to place, so the same contact there would be an unexplained
    // shipper phone number sitting in a staff group. The poster rides the shared alert payload on
    // BOTH outcome kinds (engineAlerts sets it once), so this is the TEMPLATE's decision to pin.
    const p = { name: 'DEMO POSTER NAME', mobile: '9000012345', createdBy: '90001' };
    for (const kind of ['lost', 'no_bid', 'lost_short', 'no_bid_short']) {
      const m = renderMessage(kind, { ...wonData(p), oaNo: 'OA-P2', finalRank: 4 });
      assert.ok(m, `${kind} renders`);
      assert.ok(!/Posted by/.test(m) && !/📞/.test(m), `${kind} never renders the poster contact`);
      assert.ok(!/9000012345/.test(m), `${kind} never leaks the poster's number by any other route`);
    }
    // and the alert payload itself does carry it on a loss - proving the suppression is the
    // template's, so a future won_short variant inherits the field rather than having to re-plumb it.
    const lostAlert = toNotification({ type: 'auction_result', auctionId: 'A9', won: false, finalRank: 4, poster: p });
    assert.ok(lostAlert.data.poster && lostAlert.data.poster.name === 'DEMO POSTER NAME',
      'the lost alert payload still CARRIES the poster (the template, not the router, suppresses it)');
    ok('only the won template renders the contact; lost/no_bid never do, though the payload carries it');
  }

  server.close();
  console.log(`\n${pass}/13 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
