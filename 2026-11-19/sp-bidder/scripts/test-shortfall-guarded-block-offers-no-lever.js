'use strict';
/**
 * A SHORTFALL WHOSE CORRECTIVE IS RULED OUT BY THE MINIMUM-MARGIN GUARD SHOWS ITS FACT AND NO LEVER.
 *
 * Regression target: R2-4 page half (ruling 67). When no last price at or above the guard restores
 * the lost attempts, ladderShortfall returns the fact line with action and costTarget null. The
 * price page's lwRender still revealed the lever row, so the block showed an empty action line and
 * an "Adjust prices" link that focuses the last row, inviting exactly the move the guard forbids.
 *
 * Runs the page's own lwRender, lifted from the served script, against stub elements, fed by real
 * engine previews:
 *   A  cost 1,00,000, band [12.6, 7.2, 6.3], minimum 5, gap 5,000 -> 2 of 3, guard 1,05,000,
 *      target 1,02,600 under it -> fact only.
 *   C  cost 38,000, band [14, 11.5, 10.3], minimum 6.3, gap 1,000 -> 2 of 3, target Rs 41,320 at or
 *      above the guard 40,394 -> the button carries it.
 *   a hand-built plan with no guard and every target under cost keeps the spread line and its link.
 *
 *   node scripts/test-shortfall-guarded-block-offers-no-lever.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { ladderShortfall } = require('../src/pricing/ladderNotice');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
quiet.child = () => quiet;
const caps = { standingPriceVisible: false, minDecrement: 100, revisionLimit: null, closeModel: 'unknown' };
const engine = new BidEngine({ name: 'plain', capabilities: () => caps }, null, { log: quiet });

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const start = src.indexOf('function lwHide(){');
const end = src.indexOf('lwBox.hidden=false;}', start);
assert.ok(start > 0 && end > start, 'the page script carries lwHide and lwRender');
const script = src.slice(start, end + 'lwBox.hidden=false;}'.length);

function mountBlock() {
  // Initial visibility as the served markup renders it: the block, the lever row and the button
  // start hidden, the two lines do not.
  const el = (hidden) => ({ hidden, textContent: '' });
  const els = { lwBox: el(true), lwFact: el(false), lwAct: el(false), lwActs: el(true), lwUse: el(true) };
  const render = new Function('lwBox', 'lwFact', 'lwAct', 'lwActs', 'lwUse', 'nf',
    `var lwTarget=null;${script}\nreturn lwRender;`)(els.lwBox, els.lwFact, els.lwAct, els.lwActs, els.lwUse,
    new Intl.NumberFormat('en-IN'));
  return { els, render };
}

const shortfallFor = (band, minDecrement) => ladderShortfall(engine.planPreview(
  { id: 'PV', rules: { minDecrement }, companyName: 'Acme Coatings' }, band));

let ran = 0, pass = 0;
const EXPECTED = 3;
const FAILURES = [];
function check(name, fn) {
  ran++;
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) {
    FAILURES.push({ name, message: (e && e.message) || String(e) });
    console.log('  FAIL ' + name + '\n         ' + ((e && e.message) || e));
  }
}

console.log('shortfall guarded block offers no lever');

check('1 guarded-fact-only: fixture A shows the fact, hides the action line, the button and the link', () => {
  const sh = shortfallFor({ cost: 100_000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 5 }, 5_000);
  assert.ok(sh, 'precondition: fixture A has a shortfall');
  assert.strictEqual(sh.action, null, `precondition: no action line, got ${sh.action}`);
  const { els, render } = mountBlock();
  render(sh);
  assert.strictEqual(els.lwBox.hidden, false, 'the block is shown');
  assert.strictEqual(els.lwFact.textContent, 'Only 2 of your 3 prices can be sent - this customer needs Rs 5,000 between bids.');
  assert.strictEqual(els.lwUse.hidden, true, 'no corrective button');
  assert.strictEqual(els.lwAct.hidden, true, `the empty action line is shown (textContent ${JSON.stringify(els.lwAct.textContent)})`);
  assert.strictEqual(els.lwActs.hidden, true, 'the lever row, with its "Adjust prices" link, is shown under a guarded fact');
});

check('2 control-corrective: fixture C shows the action line and a "Use Rs 41,320" button', () => {
  const sh = shortfallFor({ cost: 38_000, marginsPct: [14, 11.5, 10.3], minMarginPct: 6.3 }, 1_000);
  const { els, render } = mountBlock();
  render(sh);
  assert.strictEqual(els.lwAct.textContent, 'Set your last price at Rs 41,320 or less to send all three.');
  assert.strictEqual(els.lwAct.hidden, false);
  assert.strictEqual(els.lwActs.hidden, false);
  assert.strictEqual(els.lwUse.hidden, false);
  assert.strictEqual(els.lwUse.textContent, 'Use Rs 41,320');
});

check('3 control-spread-lever: a plan with no guard keeps the spread line and its link, no button', () => {
  const sh = ladderShortfall({ ladder: [43_320, 41_914], fittingPrices: [43_320], rungsRequested: 3,
    rungsFitting: 1, minDecrement: 40_000, spacingMinDecrement: 40_000, countsAreDeskFacing: true, trueCost: 38_000 });
  const { els, render } = mountBlock();
  render(sh);
  assert.strictEqual(els.lwAct.textContent, 'Move your prices further apart to send all three.');
  assert.strictEqual(els.lwAct.hidden, false);
  assert.strictEqual(els.lwActs.hidden, false);
  assert.strictEqual(els.lwUse.hidden, true);
});

try { engine.kill('test done'); } catch (_) {}
if (ran === EXPECTED && pass === EXPECTED) {
  console.log(`\nPASS shortfall guarded block offers no lever: ${pass}/${EXPECTED} checks passed`);
  process.exit(0);
}
console.error(`\nFAILED: ${ran}/${EXPECTED} checks ran, ${pass} passed - a shortfall with no corrective at or above `
  + 'the minimum-margin guard still reveals an empty action line or the lever row');
for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
process.exit(1);
