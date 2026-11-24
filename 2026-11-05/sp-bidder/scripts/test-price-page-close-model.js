'use strict';
/**
 * The close-model word on the operator-facing pages: soft (anti-snipe, a late bid pushes the end
 * out) vs hard (fixed end), and - the case this file exists for - NEITHER when the load's close
 * model was never verified.
 *
 * TWO render sites, pinned together on purpose:
 *   1. renderPriceForm -> a badge in the /price page HEADER, next to the load-number (the
 *      pricing desk). Moved out of renderLoadCard's load-details grid on 2026-07-30 (product-
 *      owner feedback flattened that grid from 3 columns to 2); the badge carries only the
 *      value ("Soft - limited" / "Hard close"), no separate "Close type" label - see
 *      section G below for the render-location pin.
 *   2. loadSummaryHtml -> the compact card shared by the status / expired / "too late" / track
 *      pages. Its own comment notes these are "exactly the pages someone lands on while asking
 *      'but it said 2:45?'" - so a wrong close-model word arrives precisely when someone is
 *      already disputing timing and will argue from it.
 * Both were independently fail-open, and a suite covering only the first would have stayed green
 * for the entire time the second was live. Every case below therefore asserts on BOTH views of
 * the SAME request.
 *
 * Why unknown must render nothing. The close model is a per-BRANCH SuperProcure setting read off
 * the load's own branchAuctionExtendTime (realAdapter._mapLoad -> softClose + closeModelKnown).
 * Havells and KEI each run BOTH a soft (00:03:00) and a hard (00:00:00) branch at the same time,
 * so the shipper name on the card cannot imply the model. Both sites previously rendered
 * `softClose ? soft : hard`, printing a confident "hard close" for every load whose extend time
 * SuperProcure never sent - telling the desk there was no extension war on a load that might
 * well have one. Silence is the honest output, so silence is pinned as hard as the two positive
 * labels are.
 *
 * Parses the SHIPPED bytes over real HTTP (same reasoning as test-price-page-js.js): both labels
 * are assembled inside template literals, so reading the source is the one check that cannot
 * catch a rendering mistake.
 *
 *   node scripts/test-price-page-close-model.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
// the mock stack's DurableScheduler writes intents.json on arm - keep it out of data/
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-close-model-'));

const http = require('http');
const { app, requests } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// site 1 (/price spec grid) renders the spelled-out cell values; site 2 (compact card) renders
// the terse inline word. Different presentations, one gate - so both are checked literally.
const SOFT = 'Soft - limited';
const HARD = 'Hard close';
const SOFT_W = 'soft close';
const HARD_W = 'hard close';
/** any close-model wording at all, in either casing - the "said nothing" assertion */
const ANY_WORD = /\b(soft|hard)\s*(close|-\s*(can extend|fixed end))/i;

function get(base, p) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

/**
 * The compact card's own sub-line, isolated from the rest of the page. Asserting inside this
 * region rather than across the whole document keeps unrelated page copy (or an inline script)
 * from producing a false pass/fail on the words "soft"/"hard".
 */
function subOf(html) {
  const m = /<div class="sub">([\s\S]*?)<\/div>/.exec(html);
  return m ? m[1] : '';
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const now = Date.now();
  let seq = 0;
  /**
   * One request per close-model shape, rendered through BOTH sites. `close` is spread LAST so a
   * case can omit closeModelKnown entirely (the legacy/mock shape) - the value that must never be
   * confused with a verified hard close. /track has no status or scope gate, so an awaiting
   * request reaches the compact card deterministically.
   */
  const views = async (close) => {
    const load = {
      id: `CM-${++seq}`, lane: { origin: 'Khopoli', destination: 'Keeranur' },
      equipment: 'Trailer', units: 1, companyName: 'Havells India',
      closesAt: now + 10 * 60_000, startsAt: now - 60_000, status: 'live',
      ...close,
    };
    const r = await requests.createForLoad(load, { deadlineAt: now + 60_000 });
    const price = await get(base, `/price/${r.id}`);
    const track = await get(base, `/track/${r.id}`);
    ok(price.status === 200, `fixture ${load.id}: /price renders (status ${price.status})`);
    ok(track.status === 200, `fixture ${load.id}: /track renders (status ${track.status})`);
    return { price: price.body, sub: subOf(track.body) };
  };

  // ---- A. verified soft close -> the soft word on both sites, the hard word on neither ----
  {
    const v = await views({ softClose: true, closeModelKnown: true });
    ok(v.price.includes(SOFT), 'site 1 /price: verified soft renders "Soft - limited"');
    ok(!v.price.includes(HARD), 'site 1 /price: verified soft never renders the hard label');
    // UPDATED 2026-07-30 (deliberately, not weakened): this used to check for the "Close type"
    // grid-cell LABEL text, which the redesign retired - the badge now carries only the value,
    // self-explanatory the way a status pill is. The equivalent real check is that the value
    // renders wrapped in the badge markup, not as bare text dropped somewhere on the page.
    ok(v.price.includes('class="badge ctype"'), 'site 1 /price: verified soft renders the close-model badge');
    ok(v.sub.includes(SOFT_W), 'site 2 compact card: verified soft renders "soft close"');
    ok(!v.sub.includes(HARD_W), 'site 2 compact card: verified soft never renders "hard close"');
  }

  // ---- B. verified hard close -> the hard word on both sites ----
  {
    const v = await views({ softClose: false, closeModelKnown: true });
    ok(v.price.includes(HARD), 'site 1 /price: verified hard renders "Hard close"');
    ok(!v.price.includes(SOFT), 'site 1 /price: verified hard never renders the soft label');
    ok(v.sub.includes(HARD_W), 'site 2 compact card: verified hard renders "hard close"');
    ok(!v.sub.includes(SOFT_W), 'site 2 compact card: verified hard never renders "soft close"');
  }

  // ---- C. THE REGRESSION, on BOTH sites: extend time absent/garbled -> unknown, NOT "hard" ----
  // realAdapter._mapLoad sets closeModelKnown false when branchAuctionExtendTime did not arrive
  // as a parseable HH:MM:SS. Both cards printed "hard close" here.
  {
    const v = await views({ softClose: false, closeModelKnown: false });
    ok(!v.price.includes(HARD), 'site 1 /price: UNVERIFIED does NOT render "Hard close"');
    ok(!v.price.includes(SOFT), 'site 1 /price: UNVERIFIED does NOT render the soft label');
    ok(!v.price.includes('class="badge ctype"'), 'site 1 /price: UNVERIFIED renders no close-model badge at all');
    ok(!ANY_WORD.test(v.price), 'site 1 /price: UNVERIFIED leaves no close-model wording anywhere on the page');
    ok(!v.sub.includes(HARD_W), 'site 2 compact card: UNVERIFIED does NOT render "hard close"');
    ok(!v.sub.includes(SOFT_W), 'site 2 compact card: UNVERIFIED does NOT render "soft close"');
    ok(!ANY_WORD.test(v.sub), 'site 2 compact card: UNVERIFIED leaves no close-model wording in the card');
  }

  // ---- D. legacy / mock snapshot: the field was never recorded -> unknown on both sites ----
  // undefined must not be read as "not soft, therefore hard".
  {
    const v = await views({ softClose: false });
    ok(!v.price.includes(HARD) && !v.price.includes(SOFT), 'site 1 /price: no closeModelKnown -> no label');
    ok(!v.price.includes('class="badge ctype"'), 'site 1 /price: no closeModelKnown renders no close-model badge');
    ok(!ANY_WORD.test(v.sub), 'site 2 compact card: no closeModelKnown -> no close-model wording');
  }

  // ---- E. malformed flag: a non-boolean must not pass the gate on either site ----
  // An old persisted snapshot can carry the string "true"; truthiness would admit it,
  // strict === true does not.
  {
    const v = await views({ softClose: false, closeModelKnown: 'true' });
    ok(!v.price.includes(HARD) && !v.price.includes(SOFT), 'site 1 /price: non-boolean closeModelKnown -> no label');
    ok(!ANY_WORD.test(v.sub), 'site 2 compact card: non-boolean closeModelKnown -> no wording');
  }

  // ---- F. the word is a per-LOAD read, not a per-customer one ----
  // Same shipper string, both models, in the same run: the cards must disagree. This is the
  // property a customer-name or customer-config lookup would break, and it is live today
  // (Havells and KEI each run soft and hard branches side by side).
  {
    const s = await views({ softClose: true, closeModelKnown: true });
    const h = await views({ softClose: false, closeModelKnown: true });
    ok(s.price.includes('Havells India') && h.price.includes('Havells India'),
      'per-load check: both cards carry the same shipper name');
    ok(s.price.includes(SOFT) && h.price.includes(HARD),
      'per-load check, site 1: the SAME shipper renders soft on one load and hard on another');
    ok(s.sub.includes(SOFT_W) && h.sub.includes(HARD_W),
      'per-load check, site 2: the SAME shipper renders soft on one load and hard on another');
  }

  // ---- G. the badge is back in the page header, not the spec grid and not the card's foot ----
  // UPDATED THREE TIMES, deliberately, and none of the updates weakened the case - it has always
  // pinned an EXACT location so that a badge which quietly stops rendering, or renders somewhere
  // stale, fails here rather than passing on a page-wide substring match.
  //   2026-07-30: out of renderLoadCard's spec grid (product-owner feedback flattened it from 3
  //               columns to 2) and into the page header beside the load id.
  //   2026-08-12: out of the header and onto the card's `.closebar`, beside the live countdown
  //               (PR #199) - the header corner had accumulated four stacked things and the
  //               client called it too compact.
  //   2026-08-17: REVERTED back into the header (product-owner instruction) - the card's
  //               relocation buried the badge under a three-line explanatory paragraph as the
  //               last thing on the card, so the fact that the close can still move was the last
  //               thing the desk saw. `.closebar` is gone entirely; the countdown is once again
  //               the card's bare last element.
  // The close DATE moved with it both times (it left the header for the card's meta line under
  // #199, and comes back with the badge here) - asserted below as well, so a regression that
  // reintroduces the closebar OR leaves the date stranded on the card fails either way. The
  // tri-state gate itself (verified -> badge, unverified -> nothing) is cases A-E and is
  // untouched by the move.
  {
    const v = await views({ softClose: true, closeModelKnown: true });
    const header = /<div class="brand">([\s\S]*?)<\/div>\s*<h1/.exec(v.price);
    ok(!!header && header[1].includes('class="badge ctype"') && header[1].includes(SOFT) && /#CM-\d+/.test(header[1]),
      'Close type renders in the page header as the badge, alongside the load-number (#CM-N)');
    const grid = /<div class="sgrid">([\s\S]*?)<\/div>\s*(?:<div class="saddrs"|<div class="lmeta")/.exec(v.price);
    ok(!!grid && !grid[0].includes('Close type'), 'Close type no longer renders inside the load-details grid');
    ok(!v.price.includes('class="closebar"'), 'the .closebar wrapper is gone - the badge no longer renders on the card');
    const cardFoot = /<div class="cd" id="cd"[^>]*><\/div>\s*<\/div>/.exec(v.price);
    ok(!!cardFoot, 'the live countdown is once again the bare last element of the load card');
    const closeLabel = new Date(now + 10 * 60_000).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
    ok(!!header && header[1].includes(`<span class="lddate">${closeLabel}</span>`),
      'the close date renders in the header, next to the close-model badge');
    ok(v.price.split(closeLabel).length - 1 === 1,
      'the close date renders exactly once on the page - not duplicated onto the card meta line');
  }

  server.close();

  // COMPLETION SENTINEL. run-tests.js grades a file by EXIT STATUS only, so a file that returns
  // early (or dies inside an unref'd async path) exits 0 having asserted nothing and is scored a
  // pass. Pinning the expected check count makes a vacuous green impossible: the run must reach
  // this line AND have executed every check above.
  const EXPECTED = 46;
  const ran = pass + fail;
  if (ran !== EXPECTED) {
    console.error(`  FAIL - completion sentinel: ran ${ran} checks, expected ${EXPECTED} (a check was skipped or added without updating EXPECTED)`);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  console.log(`\n${pass} passed, ${fail} failed (${ran}/${EXPECTED} checks reached the sentinel)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
