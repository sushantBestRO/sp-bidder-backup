'use strict';
/**
 * H0 - the step into the last price is refused AT PRICE ENTRY, not reported after the auction.
 *
 * The floor rung is the reserved decisive shot: _maybeBid exempts it from the min-decrement guard so
 * it always fires, and every count on the price page counts it as sent. When the step into it is
 * under the load's minimum bid difference the portal may take one price fewer than the page showed,
 * and nothing on the desk's path to Submit said so.
 *
 * The first cut of this work detected the step correctly and then sent the result to the client's
 * Director as a WhatsApp alert after the load had armed. That is bucket 3 of the price-page gate
 * wearing bucket 2's clothes: the fact is knowable the moment a cost is typed, so it belongs on the
 * form while the correction is still free. Owner ruling, 2026-09-18: "If something can fail, block
 * the action and offer the correction with a button. Do not let it succeed and then fail later."
 *
 * What is pinned here:
 *   1. the preview endpoint carries the refusal as finished copy, beside the shortfall;
 *   2. a re-price page renders it and ships the submit DISABLED, before any JavaScript runs;
 *   3. the disabled button is visually muted, not merely attribute-disabled - the distinction the
 *      zero-margin gate learned the hard way (test-zero-floor-guard.js section 14);
 *   4. the correction is offered as a price on a button, and it RAISES the price above the last one
 *      rather than lowering the last one, which would be buying an attempt back with margin;
 *   5. a clean ladder renders no block and an enabled submit;
 *   6. nothing about this condition reaches the Director's channel any more.
 *
 * Copy is held to ladderNotice.js's own rules: no "band", no "floor", no "your lowest price", no em
 * dashes, and no claim that the portal WILL refuse - whether it enforces its minimum on this step is
 * a question _reachableAt and floorStepViolation both decline to settle.
 *
 *   node scripts/test-floor-step-price-gate.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '0';
process.env.SP_MIN_PLAUSIBLE_COST = '1';
process.env.SP_MARGINS_PCT = '12.6,6.3';
process.env.SP_MIN_MARGIN_PCT = '6.3';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-floorstep-'));

const http = require('http');
const { floorStepRefusal } = require('../src/pricing/ladderNotice');
const { ERROR_KINDS, DESK_NOTICE_KINDS } = require('../src/notify/engineAlerts');
const { app, requests } = require('../src/web/server');

// Completion sentinel - run-tests.js grades by EXIT CODE alone, so a file that exits 0 after running
// nothing reads as a pass.
const EXPECTED = 6;
let sections = 0;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };
const section = (n) => { sections++; console.log(`\n${n}`); };
process.on('exit', () => {
  if (sections !== EXPECTED) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${sections} of ${EXPECTED} sections - this file `
      + 'exited early, or sections were added/removed without updating EXPECTED. NOT a pass.');
    process.exitCode = 1;
  }
});

function req(method, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => {
          let json = null; try { json = JSON.parse(buf); } catch (_) { /* html */ }
          resolve({ status: res.statusCode, text: buf, json });
        });
      });
    r.on('error', reject);
    r.end();
  });
}

const now = Date.now();
const mkLoad = (id, rules) => ({
  id, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, equipment: '32 Feet', units: 1,
  companyName: 'Havells', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules,
});

// A published minimum of 1,000 against a two-rung band on a 5,000 cost: buildBandLadder gives
// [5630, 5315], a 315 step into the last price. The engine still attempts both; the portal may take
// one. This is the commonest producer of the condition - a two-rung ladder never enters
// deriveSpacedLadder's middle loop, so nothing upstream checks that step at all.
const SHORT = { minDecrement: 1000 };
const BAND = { cost: 5_000, marginsPct: [12.6, 6.3], minMarginPct: 6.3 };
// Same minimum, a cost wide enough that every step clears it.
const CLEAN = { cost: 38_000, marginsPct: [12.6, 7.2, 2.7], minMarginPct: 2.7 };

const btnTagOf = (html) => (html.match(/<button type="submit"[^>]*>/) || [])[0] || '';
const fsBlockOf = (html) => (html.match(/<div class="lwarn bad" id="floorStep"[^>]*>[\s\S]*?<\/div>\s*<\/div>/) || [])[0] || '';

async function armedRequest(id, price) {
  const created = await requests.createForLoad(mkLoad(id, SHORT), { deadlineAt: now + 30 * 60_000 });
  await requests.store.patchDoc('priceRequests', created.id, {
    status: 'armed', marginsPct: price.marginsPct, minMarginPct: price.minMarginPct, price,
  });
  return created.id;
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // =============================================================================================
  section('1. THE COPY: what the desk is told, and what it is not told');
  // =============================================================================================
  {
    const fs1 = floorStepRefusal({
      ladder: [5_630, 5_315], ceiling: null, rungsRequested: 2, rungsFitting: 2,
      minDecrement: 1000, spacingMinDecrement: 1000, countsAreDeskFacing: true, rungsMoved: [],
      floorStepViolation: { fromPrice: 5_630, toPrice: 5_315, gap: 315, minDecrement: 1000,
        rungsLandable: 1, bindingLine: null },
    });
    ok(!!fs1, 'a short last step produces a refusal');
    ok(/may be refused/.test(fs1.fact),
      'the fact says the last price MAY be refused - _reachableAt and floorStepViolation both decline to settle whether it will');
    ok(!/will be refused|will refuse/.test(fs1.fact + fs1.action),
      'and nothing in the block asserts the refusal as settled');
    ok(/Rs 5,315/.test(fs1.fact) && /Rs 315/.test(fs1.fact) && /Rs 5,630/.test(fs1.fact),
      'it names the two prices and the gap between them');
    ok(/Rs 1,000/.test(fs1.fact), 'and the minimum this customer needs');
    ok(fs1.priceTarget === 6_315 && fs1.rowIndex === 0,
      `the correction RAISES the price above the last one to 5,315 + 1,000 (got ${fs1.priceTarget} at row ${fs1.rowIndex})`);
    ok(/Raise your first price to Rs 6,315 or more/.test(fs1.action),
      'the action names that price and which of the desk\'s own rows carries it');
    ok(!/\bband\b/i.test(fs1.fact + fs1.action) && !/\bfloor\b/i.test(fs1.fact + fs1.action)
      && !/your lowest price/i.test(fs1.fact + fs1.action),
      'the copy avoids the three phrases this client cannot parse');
    ok(!/[—–]/.test(fs1.fact + fs1.action), 'no em or en dashes');

    // A correction the customer's cap would undo is not a correction. Offer the lever with no
    // figure rather than a figure that cannot be used.
    const capped = floorStepRefusal({
      ladder: [5_630, 5_315], ceiling: 5_700, rungsRequested: 2, rungsFitting: 2,
      minDecrement: 1000, spacingMinDecrement: 1000, countsAreDeskFacing: true, rungsMoved: [],
      floorStepViolation: { fromPrice: 5_630, toPrice: 5_315, gap: 315, minDecrement: 1000,
        rungsLandable: 1, bindingLine: null },
    });
    ok(capped && capped.priceTarget === null,
      'a target above the customer\'s cap is withheld - it would be capped straight back down');
    ok(capped && /Move your last two prices further apart/.test(capped.action),
      'and the instruction falls back to the lever that has no single number');

    ok(floorStepRefusal({ ladder: [5_630, 4_315], floorStepViolation: null }) === null,
      'a ladder whose last step clears the minimum produces nothing');

    // The block stops the submit, so it must never be computed off a minimum we do not have. The
    // GoComet fallback is a hardcoded 1,000 against real slab_rates observed at both 300 and 1,000,
    // and server.js already refuses to show the desk that value as fact.
    const unknown = floorStepRefusal({
      ladder: [5_630, 5_315], ceiling: null, rungsRequested: 2, rungsFitting: 2,
      minDecrement: 1000, countsAreDeskFacing: true, minDecrementUnknown: true,
      floorStepViolation: { fromPrice: 5_630, toPrice: 5_315, gap: 315, minDecrement: 1000,
        rungsLandable: 1, bindingLine: null },
    });
    ok(unknown === null,
      'and a minimum that came from the adapter rather than the load blocks nothing - ladderCaveat carries that story');
  }

  // =============================================================================================
  section('2. THE PREVIEW ENDPOINT carries the refusal, beside the shortfall and not inside it');
  // =============================================================================================
  {
    const id = await armedRequest('FS-PREVIEW', BAND);
    const res = await req('GET', `${base}/price/${id}/preview?cost=5000&m=12.6,6.3`);
    ok(res.status === 200, `the preview answers (HTTP ${res.status})`);
    ok(res.json && res.json.floorStep && typeof res.json.floorStep.fact === 'string',
      'the response carries floorStep as finished copy');
    ok(res.json && res.json.rungsFitting === 2,
      'while rungsFitting still counts the last price as attempted - that meaning is unchanged');
    ok(res.json && /may be refused/.test(res.json.floorStep.fact),
      'and the copy is the same sentence the module composes, not a second one in the page script');
    ok(res.json && res.json.shortfall == null,
      'the shortfall stays null: every price the desk typed fits, which is exactly why no count could see this');
  }

  // =============================================================================================
  section('3. THE PAGE (GET): the block renders and the submit ships DISABLED');
  // =============================================================================================
  {
    const id = await armedRequest('FS-PAGE', BAND);
    const res = await req('GET', `${base}/price/${id}`);
    ok(res.status === 200, `the page renders (HTTP ${res.status})`);
    const block = fsBlockOf(res.text);
    ok(!!block, 'the floor-step block is present in the markup');
    ok(!/\bhidden\b/.test(block.slice(0, block.indexOf('>') + 1)),
      'and it is visible on load, before any JavaScript runs - not waiting for a keystroke');
    ok(/may be refused/.test(block), 'it carries the fact');
    ok(/Raise your first price to Rs 6,315 or more/.test(block), 'and the correction');
    ok(/id="fsUse"[^>]*>Use Rs 6,315</.test(block),
      'with that same price on a button, so the figure in the sentence and the figure on the button are one derivation');
    ok(/\bdisabled\b/.test(btnTagOf(res.text)),
      'the submit is disabled server-side - a desk with no JavaScript is stopped on load');
  }

  // =============================================================================================
  section('4. THE DISABLED SUBMIT IS VISUALLY MUTED, not merely attribute-disabled');
  // =============================================================================================
  {
    // The lesson from the zero-margin gate: the attribute alone left the button rendering
    // live-green, so a code-disabled button was indistinguishable from a working one. The block's
    // own red state is pinned here for the same reason - it sits in the same slot as the amber
    // shortfall, which does NOT stop the button, and the two must not read as the same severity.
    const id = await armedRequest('FS-VISUAL', BAND);
    const res = await req('GET', `${base}/price/${id}`);
    ok(/\bdisabled\b/.test(btnTagOf(res.text)), 'precondition: this fixture renders a disabled submit');
    const style = (res.text.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
    const disabledRule = (style.match(/(?:^|[}\s;])button:disabled\{([^}]*)\}/) || [])[1] || '';
    ok(/background:\s*var\(--muted\)/.test(disabledRule) && /cursor:\s*not-allowed/.test(disabledRule),
      'the page\'s button:disabled rule visibly mutes it');
    ok(!disabledRule.includes('var(--primary)') && !/color:\s*#fff/.test(disabledRule),
      'and does not repeat the live-button colors');
    const badRule = (style.match(/\.lwarn\.bad\{([^}]*)\}/) || [])[1] || '';
    ok(!!badRule, 'the blocking block has its own state rule');
    const warnRule = (style.match(/(?:^|[}\s;])\.lwarn\{([^}]*)\}/) || [])[1] || '';
    ok(!!warnRule && badRule !== warnRule,
      'which differs from the amber shortfall sharing its slot - only one of the two stops the button');
  }

  // =============================================================================================
  section('5. A CLEAN LADDER: no block, no disabled submit');
  // =============================================================================================
  {
    const id = await armedRequest('FS-CLEAN', CLEAN);
    const res = await req('GET', `${base}/price/${id}`);
    const block = fsBlockOf(res.text);
    ok(!!block, 'the block is still in the markup, so the script has a node to fill');
    ok(/\bhidden\b/.test(block.slice(0, block.indexOf('>') + 1)), 'but hidden');
    ok(!/\bdisabled\b/.test(btnTagOf(res.text)), 'and the submit is live - nothing to correct');
    const pv = await req('GET', `${base}/price/${id}/preview?cost=38000&m=12.6,7.2,2.7`);
    ok(pv.json && pv.json.floorStep === null, 'the preview returns no refusal for it either');
  }

  // =============================================================================================
  section('6. NOTHING ABOUT THIS REACHES THE DIRECTOR any more');
  // =============================================================================================
  {
    // The condition is knowable at entry, so the only honest place for it is the form. An alert on
    // the way out of arm() could only describe a load already committed, which is the shape the
    // owner ruled against. Pinned as an absence because a kind added back to either routing set is
    // how it would silently return.
    const gone = 'ladder_floor_step_below_min_decrement';
    ok(!ERROR_KINDS.has(gone), 'the kind is not on the ops error channel');
    ok(!DESK_NOTICE_KINDS.has(gone), 'nor on the desk notice channel');
  }

  server.close();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
