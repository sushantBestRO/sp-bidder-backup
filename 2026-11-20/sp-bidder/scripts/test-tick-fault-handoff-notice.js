'use strict';
/**
 * THE TICK-FAULT HAND-OFF NOTICE - what the desk group actually reads when three contained tick
 * faults in a row hand a load over.
 *
 * Regression target: owner ruling OQ-1 (2026-09-24), cluster W1-5 - after 3 consecutive contained
 * tick faults the desk group is TOLD TO BID THE LOAD BY HAND.
 *   sibling: scripts/test-tick-fault-handoff.js (the engine emits the hand-off and routes it)
 *
 * waTemplates.js  deskNoticeHeadline:  let lead = 'Not bidding'; let what = 'this load cannot be bid';
 *
 * The headline is the WhatsApp chat-list preview. A hand-off that falls through to the default
 * refusal previews as "Not bidding - <customer>: this load cannot be bid" while the body asks for a
 * hand bid, and a desk reading only the preview drops the one load it was asked to rescue. The body
 * (deskNoticeAction) and the figures (tickFaultHandoffFigures) must also stay hand-off specific:
 * the generic copy names no close time, and "our bid above stays on the board" with no bid above is
 * a false sentence.
 *
 * The desk copy is still under owner review, so MEANING is pinned, not wording: loose regexes only.
 *
 * WHAT MUST NOT MOVE:
 *   - another desk_notice kind keeps its own headline (check 6, control).
 *
 * Pure functions: engine-shaped event -> engineAlerts.toNotification -> waTemplates.renderMessage.
 * No network, no timers.
 *
 *   node scripts/test-tick-fault-handoff-notice.js
 */
const assert = require('assert');
const { toNotification } = require('../src/notify/engineAlerts');
const { renderMessage } = require('../src/notify/waTemplates');

let pass = 0;
const failures = [];
const check = (n, name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${n}. ${name}`); } catch (e) {
    failures.push(n);
    console.log(`  FAIL ${n}. ${name}\n       ${e.message.split('\n').join('\n       ')}`);
  }
};

const CLOSE = Date.UTC(2026, 8, 24, 10, 30);
const handoff = (o) => Object.assign({
  type: 'alert', level: 'error', kind: 'tick_fault_handoff', auctionId: '26100002',
  faultSince: 1_790_000_000_000, consecutiveFaults: 3, landedBids: 0, standingBidPrice: null, myRank: null,
  closesAt: CLOSE, detail: 'Load 26100002: 3 checks in a row failed on our side.',
  lane: { origin: 'Palghar', destination: 'Jaipur' }, companyName: 'Waaree Energies', branchName: 'Bhiwandi',
  laneCells: null,
}, o);
const render = (evt) => {
  const n = toNotification(evt);
  assert.ok(n && n.kind === 'desk_notice', `SETUP: ${evt.kind} must route to desk_notice, got ${n && n.kind}`);
  const m = renderMessage(n.kind, n.data);
  assert.ok(typeof m === 'string' && m.length > 0, `SETUP: ${evt.kind} rendered nothing`);
  return m;
};
const headline = (m) => m.split('\n')[0];
const body = (m) => m.split('\n').slice(1).join('\n');
const MONEY = /(Rs\.?|₹)\s*[\d,]+/i;

const none = render(handoff({}));
const held = render(handoff({ landedBids: 2, standingBidPrice: 41_000, myRank: 2 }));
const control = render({
  type: 'alert', level: 'warn', kind: 'last_resort_floor_fired', auctionId: '26100003', floor: 55_577,
  landedBids: 3, myRank: 2, lane: { origin: 'Palghar', destination: 'Jaipur' }, companyName: 'Waaree Energies',
});

check(1, 'the headline (chat-list preview) asks for a hand bid and never says the load cannot be bid', () => {
  assert.ok(/by hand/i.test(headline(none)), `headline: ${headline(none)}`);
  assert.ok(/by hand/i.test(headline(held)), `headline: ${headline(held)}`);
  for (const m of [none, held]) assert.ok(!/cannot be bid/i.test(m), `the default refusal leaked into the hand-off:\n${m}`);
});

check(2, 'nothing landed: the body says no bid of ours is on the load, asks for a hand bid, shows no bid figure', () => {
  const b = body(none);
  assert.ok(/no bid of ours|none of our bids|we have no bid/i.test(b), `body does not say nothing of ours is on the load:\n${b}`);
  assert.ok(/by hand/i.test(b), `body does not ask for a hand bid:\n${b}`);
  assert.ok(!MONEY.test(none), `a money figure rendered when no bid of ours landed:\n${none}`);
});

check(3, 'bid standing: the standing price renders with Indian separators and the body says it stays on the board', () => {
  assert.ok(/(Rs\.?|₹)\s*41,000\b/.test(held), `standing bid 41,000 missing:\n${held}`);
  assert.ok(/(stays|remains|still)\b[^\n]*on the board/i.test(body(held)), `body does not say our bid stays on the board:\n${held}`);
  assert.ok(!/no bid of ours/i.test(held), `the nothing-landed copy leaked into the standing branch:\n${held}`);
});

check(4, 'the figures carry the close time and our rank (the desk has to beat a close it can see)', () => {
  for (const m of [none, held]) {
    assert.ok(/close[^\n]*\d{2}-\d{2}-2026/i.test(m), `no close-time line:\n${m}`);
  }
  assert.ok(/(stand|rank)[^\n]*\b2\b/i.test(held), `rank 2 missing:\n${held}`);
});

check(5, 'voice: no bot, no em dash, no pricing vocabulary, no platform name on either variant', () => {
  for (const m of [none, held]) {
    assert.ok(!/\bbots?\b/i.test(m), `says bot:\n${m}`);
    assert.ok(!m.includes('—'), `em dash:\n${m}`);
    assert.ok(!/\bfloor\b|\bband\b|your lowest price/i.test(m), `pricing vocabulary:\n${m}`);
    assert.ok(!/superprocure|gocomet/i.test(m), `platform name that is wrong on the other platform:\n${m}`);
  }
});

check(6, 'control: another desk_notice kind keeps its own headline', () => {
  assert.ok(!/by hand/i.test(headline(control)), `hand-off lead leaked into last_resort_floor_fired: ${headline(control)}`);
  assert.notStrictEqual(headline(control).replace(/\s+/g, ' '), headline(none).replace(/\s+/g, ' '));
});

if (failures.length) {
  console.error(`\nFAILED checks: ${failures.join(', ')} (${pass}/6 passed) - the tick_fault_handoff desk notice `
    + 'no longer tells the desk to bid the load by hand (deskNoticeHeadline / deskNoticeAction / tickFaultHandoffFigures)');
  process.exit(1);
}
const EXPECTED = 6;
assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
console.log(`\n${pass}/${EXPECTED} checks passed`);
