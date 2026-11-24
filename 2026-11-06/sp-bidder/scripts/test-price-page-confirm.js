'use strict';
/**
 * The /price soft low-cost guard is an IN-APP dialog, not window.confirm.
 *
 * window.confirm blocks the tab, cannot be styled, and renders browser chrome around a bare
 * line of text - on a public capture link sent to a desk over WhatsApp that reads as something
 * to close, not something to answer. The page already had its own toast (showToast); this pins
 * the matching confirm.
 *
 * Asserts against the SHIPPED bytes over real HTTP, for the same reason test-price-page-js.js
 * does: the failure mode lives in the gap between what the source says and what the template
 * literal actually emits, so reading the source is the one check that cannot catch it.
 *
 * Behaviour pinned (unchanged from the window.confirm version, only the surface differs):
 *   - a cost in the soft low band still needs an explicit confirmation before it can submit
 *   - the ordinary (not-low) path is NOT deferred behind a dialog
 *   - the hard clerical-error floor is still checked BEFORE the soft confirmation, so the hard
 *     band can never be waved through by confirming
 *   - both submit paths (capture = native form post, re-price = JSON) go through it
 *
 *   node scripts/test-price-page-confirm.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_MIN_PLAUSIBLE_COST = '500'; // soft band
process.env.SP_MIN_COST_ABS = '0';         // hard band off - this file is about the soft one
process.env.SP_MIN_COST_PER_KM = '0';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const assert = require('assert');
const http = require('http');
const { app, store } = require('../src/web/server');
const { PriceRequestStore, publicSeg } = require('../src/pricing/priceRequests');

let pass = 0;
const ok = (m) => { console.log('  ok  ' + m); pass++; };

function get(base, p) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve(buf));
    }).on('error', reject);
  });
}

/** Every inline <script> body on the page, concatenated in document order. */
function scripts(html) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, out = '';
  while ((m = re.exec(html))) out += m[1] + '\n';
  return out;
}

const load = (over = {}) => ({
  id: 'L-C1',
  lane: { origin: 'Pune', destination: 'Banglore' },
  companyName: 'ADAMA India Private Limited',
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

  // Two page states, because they use DIFFERENT submit mechanics: capture posts the form
  // natively, re-price posts JSON. The dialog had to be wired into both.
  const captureReq = await requests.createForLoad(load(), { deadlineAt: Date.now() + 18 * 60_000 });
  const repriceReq = await requests.createForLoad(load({ id: 'L-C2' }), { deadlineAt: Date.now() + 18 * 60_000 });
  await requests.capture(repriceReq.id, { cost: 50_000 });

  const captureJs = scripts(await get(base, `/price/${publicSeg(captureReq)}`));
  const repriceJs = scripts(await get(base, `/price/${publicSeg(repriceReq)}`));

  // ---- 1. the native dialog is gone from what we actually ship ----
  for (const [name, js] of [['capture', captureJs], ['re-price', repriceJs]]) {
    assert.ok(!/(?<![\w$.])(?:window\s*\.\s*)?confirm\s*\(/.test(js.replace(/lowCostConfirm\s*\(/g, '')),
      `${name} page ships no native confirm()`);
  }
  ok('neither page state ships a native confirm()');

  // ---- 2. the in-app dialog IS shipped, with its markup + styling ----
  for (const [name, js] of [['capture', captureJs], ['re-price', repriceJs]]) {
    assert.ok(/function askConfirm\(/.test(js), `${name} page ships askConfirm`);
    assert.ok(/function lowCostConfirm\(/.test(js), `${name} page ships lowCostConfirm`);
    assert.ok(/aria-modal/.test(js), `${name} dialog marks itself aria-modal`);
    assert.ok(/Escape/.test(js), `${name} dialog cancels on Escape`);
  }
  ok('both page states ship the in-app dialog (askConfirm + aria-modal + Escape)');

  const captureHtml = await get(base, `/price/${publicSeg(captureReq)}`);
  assert.ok(/\.mdl\b/.test(captureHtml) && /\.mask\b/.test(captureHtml), 'dialog CSS is inlined on the page');
  ok('dialog CSS ships with the page (no external stylesheet to fail open)');

  // ---- 3. the guard ORDER survives: hard floor is checked before the soft confirmation ----
  // If this inverts, a missing-digit rate becomes confirm-through-able, which is the exact
  // thing the hard band exists to refuse.
  // Compare the CALL sites, not the definitions - the helpers are declared in the opposite
  // order to the order they run in, so matching a bare name here would pin nothing.
  for (const [name, js] of [['capture', captureJs], ['re-price', repriceJs]]) {
    const hard = js.indexOf('!hardFloorOk()');
    const soft = js.indexOf('lowCostConfirm(function(');
    assert.ok(hard > -1, `${name} page calls hardFloorOk in a submit handler`);
    assert.ok(soft > -1, `${name} page routes its submit through lowCostConfirm`);
    assert.ok(hard < soft, `${name} page checks the hard floor BEFORE the soft confirmation`);
  }
  ok('hard clerical-error floor is still evaluated before the soft confirmation');

  // ---- 4. the low-band ack is still stamped, so the server-side backstop agrees ----
  for (const [name, js] of [['capture', captureJs], ['re-price', repriceJs]]) {
    assert.ok(/low_cost_ack/.test(js), `${name} page still stamps low_cost_ack`);
    assert.ok(/inLowCostBand\(/.test(js), `${name} page decides the band from one helper`);
  }
  ok('low_cost_ack is still stamped from a single band helper');

  // ---- 5. the ordinary path is not deferred behind a dialog ----
  // lowCostConfirm must run its callback straight away when the cost is not in the low band,
  // otherwise every normal submit would grow a dialog. Executed, not just grepped.
  const fn = /function lowCostConfirm\(onOk\)\{([\s\S]*?)\n\}/.exec(repriceJs);
  assert.ok(fn, 'lowCostConfirm body is extractable');
  let ranSync = false;
  const sandbox = new Function('inLowCostBand', 'askConfirm', 'nf', 'cval', `
    function lowCostConfirm(onOk){${fn[1]}}
    return lowCostConfirm;
  `)(
    () => false,                                  // not in the low band
    () => { throw new Error('dialog shown for an ordinary cost'); },
    { format: (n) => String(n) },
    () => 50000,
  );
  sandbox(() => { ranSync = true; });
  assert.strictEqual(ranSync, true, 'an ordinary cost submits without a dialog');
  ok('an ordinary cost is not deferred - the callback runs synchronously');

  // and the low band DOES route to the dialog rather than submitting silently
  let asked = false, submitted = false;
  const sandbox2 = new Function('inLowCostBand', 'askConfirm', 'nf', 'cval', `
    function lowCostConfirm(onOk){${fn[1]}}
    return lowCostConfirm;
  `)(
    () => true,                                   // in the low band
    (_t, _m, _l, onOk) => { asked = true; void onOk; },
    { format: (n) => String(n) },
    () => 2,
  );
  sandbox2(() => { submitted = true; });
  assert.strictEqual(asked, true, 'a low cost raises the dialog');
  assert.strictEqual(submitted, false, 'a low cost does NOT submit until confirmed');
  ok('a low cost raises the dialog and does not submit until it is confirmed');

  server.close();
  console.log(`\n${pass}/7 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
