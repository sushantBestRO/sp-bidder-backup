'use strict';

/**
 * The desk-facing half: the WhatsApp copy, the routing kind it rides, and the off-by-default gate.
 */

const assert = require('assert');
const fs = require('fs');   // allowed: this is a test, reading source as the structural gate scanner
const path = require('path');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

let checks = 0;
const ok = (name) => { checks += 1; console.log(`  ok  ${name}`); };

const BASE = {
  shipperName: 'Waaree', loadId: '260817N3VH', loadCode: null, shipperRef: '3262600276',
  link: 'https://x.example/price/abc', targetRate: true,
  targetPrice: 98000, standingPrice: 102695,
  deadlineAt: Date.now() + 14 * 60_000, chargeLineCount: 1,
};

// ---- routing ---------------------------------------------------------------------------------

assert.strictEqual(templateFor('price_needed', BASE), 'price_target_rate');
assert.strictEqual(templateFor('price_needed', { ...BASE, targetRate: false }), 'price_needed');
assert.strictEqual(templateFor('price_needed', {}), 'price_needed');
ok('a target-rate payload selects its own copy; every other price ask is untouched');

// ---- the copy --------------------------------------------------------------------------------

const msg = renderMessage('price_target_rate', BASE);
assert.ok(msg, 'the template is registered');
assert.ok(msg.includes('98,000'), 'the target is shown in Indian digit grouping');
assert.ok(msg.includes('1,02,695'), 'our standing quote is shown beside it');
assert.ok(msg.includes(BASE.link), 'the capture link rides');
ok('the ask leads with what they want against what we quoted');

// House voice, enforced here because nothing lints it.
assert.ok(!/—/.test(msg), 'no em dashes - this is pasted into WhatsApp');
assert.ok(!/\bbot\b/i.test(msg), 'the word "bot" never appears in desk copy');
assert.ok(!/negotiat|indicative|is_negotiating|API|endpoint|payload/i.test(msg), 'no platform jargon');
assert.ok(!/STATUS\.md|\.build|KNOWLEDGE/i.test(msg), 'no internal artefact names');
ok('the copy carries no em dash, no jargon and no internal references');

// ---- the multi-vehicle warning ----------------------------------------------------------------

const single = renderMessage('price_target_rate', BASE);
assert.ok(!/vehicle types/i.test(single), 'a single-vehicle load carries no warning');
const multi = renderMessage('price_target_rate', { ...BASE, chargeLineCount: 2 });
assert.ok(/2 vehicle types/i.test(multi), 'the count is named');
assert.ok(/by hand/i.test(multi), 'and the desk is told it must be done on the portal');
ok('a multi-vehicle-type target warns that it cannot be submitted for them');

// ---- the deadline clause ----------------------------------------------------------------------

const soon = renderMessage('price_target_rate', { ...BASE, deadlineAt: Date.now() + 9 * 60_000 + 20_000 });
assert.ok(/in 9 minutes/.test(soon), 'a short window is stated in plain minutes');
const hour = renderMessage('price_target_rate', { ...BASE, deadlineAt: Date.now() + 59 * 60_000 + 20_000 });
assert.ok(/in 59 minutes/.test(hour), 'the longer observed window too');
const past = renderMessage('price_target_rate', { ...BASE, deadlineAt: Date.now() - 1000 });
assert.ok(!/NaN|Invalid|undefined/.test(past), 'a lapsed deadline degrades cleanly');
ok('the reply window reads in plain minutes and degrades cleanly when lapsed');

// A missing number must never render as a bare "null"/"NaN" in front of the desk.
const empty = renderMessage('price_target_rate', { ...BASE, targetPrice: null, standingPrice: null });
assert.ok(!/null|NaN|undefined/.test(empty), 'absent money renders as a dash, not a null');
ok('absent numbers render as a dash rather than null');

// ---- the gate is off by default ----------------------------------------------------------------

{
  const saved = process.env.GC_TARGET_PRICE;
  delete process.env.GC_TARGET_PRICE;
  delete require.cache[require.resolve('../src/config')];
  assert.strictEqual(require('../src/config').gocomet.targetPriceEnabled, false,
    'absent env means the watch is not constructed');
  process.env.GC_TARGET_PRICE = '0';
  delete require.cache[require.resolve('../src/config')];
  assert.strictEqual(require('../src/config').gocomet.targetPriceEnabled, false,
    'only the literal "1" turns it on, matching every sibling GC gate');
  process.env.GC_TARGET_PRICE = '1';
  delete require.cache[require.resolve('../src/config')];
  assert.strictEqual(require('../src/config').gocomet.targetPriceEnabled, true);
  if (saved === undefined) delete process.env.GC_TARGET_PRICE; else process.env.GC_TARGET_PRICE = saved;
  delete require.cache[require.resolve('../src/config')];
  ok('GC_TARGET_PRICE defaults off and only a literal 1 enables it');
}

// INERTNESS WITH THE GATE OFF. This is the property the whole feature ships on: it goes to a live
// box running five other processes, and with GC_TARGET_PRICE unset it must do nothing at all - no
// watch, no timer, no read against the budget discovery competes for. Asserted structurally,
// because "we checked and it looked fine" is what a boot-order regression walks straight through.
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.js'), 'utf8');
  const fn = src.slice(src.indexOf('function attachTargetPriceWatch()'));
  const body = fn.slice(0, fn.indexOf('\nfunction '));

  // the gate is the FIRST thing the function does, and it returns rather than falling through
  const firstLine = body.split('\n')[1] || '';
  assert.ok(/if \(!config\.gocomet\.targetPriceEnabled/.test(firstLine) && /return null/.test(firstLine),
    'the gate is the first statement of attachTargetPriceWatch and returns');

  // nothing that costs anything can sit above that return
  const gateIdx = body.indexOf('targetPriceEnabled');
  for (const costly of ['new TargetPriceWatch', 'setInterval', 'rehydrate(']) {
    const at = body.indexOf(costly);
    assert.ok(at === -1 || at > gateIdx, `${costly} sits below the gate, never above it`);
  }

  // and the cycle refuses to run without a constructed watch, so a stray timer cannot poll either
  assert.ok(/if \(!targetPriceWatch \|\| targetPriceCycleBusy\) return;/.test(src),
    'the watch cycle returns immediately when no watch was constructed');
  ok('with GC_TARGET_PRICE off nothing is constructed, scheduled, or read');
}

const EXPECTED = 8;
assert.strictEqual(checks, EXPECTED, `expected ${EXPECTED} checks, ran ${checks} - the file did not run to completion`);
console.log(`\n${checks}/${EXPECTED} checks passed`);
