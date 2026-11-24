'use strict';

/**
 * Pins the target-rate parser against the REAL captured GoComet bodies from 2026-08-19.
 *
 * The fixtures are VENDORED INTO THIS REPO (scripts/fixtures/) rather than read from the
 * surrounding working tree. They used to resolve through ../../../ into a sibling directory that
 * exists only on the author's machine, so these two suites passed locally and failed in CI on a
 * standalone checkout. A test that cannot run where CI runs it is not a test.
 *
 * The rank_changed entries carry a competitor's company and a working email on the wire. That is
 * the identity stripRivalIdentity exists to drop, and committing it would put it in this repo's
 * history permanently, so it is replaced in the vendored copy with an example.invalid placeholder.
 * The strip is proven against the placeholder - the mechanism is what is under test, not the name.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  parseTargetDeadlineMs, readTargetPrice, isActionableTarget,
  stripRivalIdentity, parseTargetFromNotification,
} = require('../src/platform/gocometTargetPrice');

const FIXTURES = path.resolve(__dirname, 'fixtures/gocomet-target-price-2026-08-19');
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));
// The fixtures ship with the repo, so absence is a broken checkout - not a reason to run a
// weaker suite. Fail here rather than at the end, so the message names the cause.
if (!fs.existsSync(FIXTURES)) {
  console.error(`FIXTURES MISSING at ${FIXTURES} - this suite cannot verify anything without them`);
  process.exit(1);
}
const haveFixtures = true;

let checks = 0;
const ok = (name) => { checks += 1; console.log(`  ok  ${name}`); };

// 17 Aug 2026 20:50 IST - inside the N3VH window (target 20:46:15, deadline 21:00).
const DURING_N3VH = Date.UTC(2026, 7, 17, 15, 20, 0);

// ---- deadline parsing -------------------------------------------------------------------------

assert.strictEqual(parseTargetDeadlineMs('17/08/2026 21:00', DURING_N3VH),
  Date.UTC(2026, 7, 17, 15, 30, 59), 'IST deadline resolves to 21:00:59 +05:30');
ok('the DD/MM/YYYY IST deadline parses to the right instant');

assert.strictEqual(Date.parse('17/08/2026 21:00'), NaN,
  'guard: if the platform ever makes this Date.parse-able, revisit the custom parser');
ok('Date.parse genuinely cannot read this format (why the custom parser exists)');

// The trap: 05/08 is 5 August in GoComet and 8 May to a US-order parser. A wrong answer here is
// silent and three months off, so it is pinned rather than assumed.
assert.strictEqual(parseTargetDeadlineMs('05/08/2026 09:30', Date.UTC(2026, 7, 5, 0, 0, 0)),
  Date.UTC(2026, 7, 5, 4, 0, 59), 'day-first, not month-first');
ok('an ambiguous DD/MM date is read day-first');

assert.strictEqual(parseTargetDeadlineMs('31/02/2026 10:00', DURING_N3VH), null);
ok('an impossible calendar date is refused rather than rolled forward');

for (const bad of [null, undefined, '', 'tomorrow', '2026-08-17T21:00:00', '17/13/2026 10:00', '17/08/2026 25:00']) {
  assert.strictEqual(parseTargetDeadlineMs(bad, DURING_N3VH), null, `refused: ${String(bad)}`);
}
ok('malformed and out-of-range deadlines all fail closed');

assert.strictEqual(parseTargetDeadlineMs('17/08/2100 21:00', DURING_N3VH), null);
ok('an absurdly-far-future deadline is bounded out');

assert.strictEqual(parseTargetDeadlineMs('17/08/2026 21:00 IST', DURING_N3VH),
  Date.UTC(2026, 7, 17, 15, 30, 59), 'the notification renders the same value with an IST suffix');
ok('the IST-suffixed form parses identically');

// ---- hydration off a real /quotes body --------------------------------------------------------

if (haveFixtures) {
  const n3vh = readTargetPrice(load('05_quotes_N3VH.json'), DURING_N3VH);
  assert.ok(n3vh, 'N3VH carries a target');
  assert.strictEqual(n3vh.targetPricePerUnit, 98000, 'target price is the sibling of negotiate_data, not inside it');
  assert.strictEqual(n3vh.targetDeadlineMs, Date.UTC(2026, 7, 17, 15, 30, 59));
  assert.strictEqual(n3vh.negotiationStatus, 'negotiation_complete');
  assert.strictEqual(n3vh.standingPricePerUnit, 99000, 'our own standing number comes off charges_list');
  assert.strictEqual(n3vh.enquiryVendorId, '0c05d066-58a5-4d4f-ab65-6f272cf7d0b0');
  ok('the real N3VH capture hydrates target, deadline and our standing price');

  // The correction that matters: a design keyed on negotiate_data alone gets a date and no money.
  const raw = load('05_quotes_N3VH.json')[0].indicative_charges_list;
  assert.strictEqual(raw.negotiate_data.comment, null);
  assert.strictEqual(raw.negotiate_data.deadline, '17/08/2026 21:00');
  assert.strictEqual(raw.total_charge.price, 98000, 'the money is in total_charge, NOT negotiate_data');
  ok('negotiate_data holds no price - the number is its sibling total_charge');

  // Q9LG expired unanswered and the platform CLEARED the numbers. This is why hydration has to
  // happen while the window is open: after it lapses there is nothing left on /quotes to read.
  const q9lg = readTargetPrice(load('03_quotes_Q9LG.json'), DURING_N3VH);
  assert.strictEqual(q9lg.negotiationStatus, 'negotiation_no_reply');
  assert.strictEqual(q9lg.targetPricePerUnit, null, 'price cleared after an unanswered window');
  assert.strictEqual(q9lg.targetDeadlineMs, null, 'deadline cleared too');
  assert.strictEqual(isActionableTarget(q9lg, DURING_N3VH), false);
  ok('an expired unanswered target reads back empty (hydrate during the window, not after)');

  // is_negotiating is the design-of-record detection flag and it is FALSE on both loads that
  // demonstrably carried a target. Pinned so the claim cannot quietly be restated as verified.
  assert.strictEqual(load('05_quotes_N3VH.json')[0].is_negotiating, false);
  assert.strictEqual(load('03_quotes_Q9LG.json')[0].is_negotiating, false);
  ok('is_negotiating is false on both real target-price loads (never observed true anywhere)');

  // THE MONEY INVARIANT. The target is denominated in the platform's total_per_unit_by_quote space,
  // and that number is the SUM of the per-line prices - not any one line's price. Pinned across
  // every captured body because the write path sets a single line, so on a multi-line quote there
  // is no one number that means the target, and writing it to a line would bid it N times over.
  for (const f of ['05_quotes_N3VH.json', '03_quotes_Q9LG.json', '12_quotes_KQIF_2type.json', '15_quotes_5T8R_187units.json']) {
    const q = load(f)[0];
    const lines = Object.entries(q.charges_list['11_freight_charges']).filter(([k, v]) => k !== 'display_name' && v && typeof v === 'object');
    const sum = lines.reduce((a, [, v]) => a + Number(v.price), 0);
    assert.strictEqual(sum, q.total_charges.total.total_per_unit_by_quote, `${f}: sum of lines == total_per_unit_by_quote`);
    const grand = lines.reduce((a, [, v]) => a + Number(v.price) * Number(v.units), 0);
    assert.strictEqual(grand, q.total_charges.total.total, `${f}: sum(price x units) == total`);
    assert.strictEqual(readTargetPrice(q, DURING_N3VH) ? readTargetPrice(q, DURING_N3VH).chargeLineCount : lines.length, lines.length);
  }
  ok('target space == sum of per-line prices == total_per_unit_by_quote, on all four captures');

  const q9lgLines = readTargetPrice(load('03_quotes_Q9LG.json'), DURING_N3VH);
  assert.strictEqual(q9lgLines.chargeLineCount, 2);
  assert.strictEqual(q9lgLines.autoBiddable, false,
    'the one load that actually cost money is multi-line, so it can never be auto-re-quoted');
  const n3vhLines = readTargetPrice(load('05_quotes_N3VH.json'), DURING_N3VH);
  assert.strictEqual(n3vhLines.autoBiddable, true, 'single-line collapses the three price spaces into one');
  ok('a multi-line target is flagged not-auto-biddable (placeBid refuses it anyway)');

  const none = readTargetPrice(load('16_quotes_3BSZ_single.json'), DURING_N3VH);
  assert.strictEqual(none, null, 'a never-negotiated load carries no target');
  assert.strictEqual(isActionableTarget(none, DURING_N3VH), false);
  ok('a never-negotiated load yields no target and is not actionable');

  // chargeLineCount decides whether we refuse a load as multi-truck-type, so it has to count the
  // SAME lines placeBid would price. Two ways it used to disagree, both money-visible.
  {
    const base = load('05_quotes_N3VH.json');
    const groupKeyOf = (q) => Object.keys(q.charges_list).find((k) => /_freight_charges$/.test(k));

    // (a) an ACCESSORIAL line in the same container is not a truck type. lr_charges and others
    // both appear there on a real tenant, and counting them refused a single-truck load.
    const withAccessorial = JSON.parse(JSON.stringify(base));
    const gk = groupKeyOf(withAccessorial[0]);
    withAccessorial[0].charges_list[gk].lr_charges = { price: 500, units: 1 };
    withAccessorial[0].charges_list[gk].others = { price: 250, units: 1 };
    const acc = readTargetPrice(withAccessorial, DURING_N3VH);
    assert.strictEqual(acc.chargeLineCount, 1, 'accessorial lines are not counted as truck types');
    assert.strictEqual(acc.autoBiddable, true, 'so a single-truck load is still answerable');

    // (b) the group key is not hardcoded. A differently-numbered freight group used to read ZERO
    // lines, and zero fails the `> 1` multi-line guard OPEN on a genuinely multi-type quote.
    const renamed = JSON.parse(JSON.stringify(base));
    const ok0 = groupKeyOf(renamed[0]);
    renamed[0].charges_list['09_freight_charges'] = renamed[0].charges_list[ok0];
    delete renamed[0].charges_list[ok0];
    assert.strictEqual(readTargetPrice(renamed, DURING_N3VH).chargeLineCount, 1,
      'a differently-numbered freight group still resolves, rather than reading zero lines');
    ok('the line count matches what the write path would price, not what the container holds');
  }
}

// ---- notification parsing + the legal wall ----------------------------------------------------

if (haveFixtures) {
  const feed = load('20_notif_N3VH.json').notifications.notifications;
  const target = feed.find((n) => n.channel_intent === 'quote_indicative');
  const parsed = parseTargetFromNotification(target, DURING_N3VH);
  assert.strictEqual(parsed.targetPricePerUnit, 98000);
  assert.strictEqual(parsed.standingPricePerUnit, 102695, 'Indian digit grouping parses');
  assert.strictEqual(parsed.targetDeadlineMs, Date.UTC(2026, 7, 17, 15, 30, 59));
  assert.strictEqual(parsed.enquiryKey, '260817N3VH');
  ok('the notification feed yields the same target the quote does');

  const q9feed = load('21_notif_Q9LG.json').notifications.notifications;
  const q9target = parseTargetFromNotification(q9feed.find((n) => n.channel_intent === 'quote_indicative'), Date.UTC(2026, 7, 17, 12, 40, 0));
  assert.strictEqual(q9target.targetPricePerUnit, 190000);
  assert.strictEqual(q9target.comment, 'Immediate Requirement');
  ok('the feed retains the numbers for the window that expired unanswered');

  // THE LEGAL WALL. Both captures name the carrier that displaced us, with a live email address.
  const rank = feed.find((n) => n.channel_intent === 'rank_changed');
  assert.ok(/example\.invalid|REDACTED RIVAL/i.test(JSON.stringify(rank)), 'fixture really does carry a rival identity to strip');
  const stripped = stripRivalIdentity(rank);
  const serialized = JSON.stringify(stripped);
  for (const leak of ['example.invalid', 'REDACTED RIVAL', 'rival@', 'Reduce your quote']) {
    assert.ok(!serialized.includes(leak), `rival identity leaked through: ${leak}`);
  }
  assert.strictEqual(stripped.intent, 'rank_changed', 'the event type survives - only the identity is dropped');
  assert.strictEqual(parseTargetFromNotification(rank, DURING_N3VH), null);
  ok('rank_changed is stripped of the rival company, email and subject at the parse boundary');

  const shipperEvent = stripRivalIdentity(target);
  assert.strictEqual(shipperEvent.authorCompany, 'Waaree Energies Ltd.',
    'the SHIPPER is the customer, not a competitor, so naming them is fine');
  ok('the shipper is still named on their own target-rate event');
}

// ---- actionability ----------------------------------------------------------------------------

const live = { negotiationStatus: 'negotiation_in_progress', targetPricePerUnit: 98000, targetDeadlineMs: DURING_N3VH + 600_000 };
assert.strictEqual(isActionableTarget(live, DURING_N3VH), true);
assert.strictEqual(isActionableTarget({ ...live, targetDeadlineMs: DURING_N3VH - 1 }, DURING_N3VH), false);
assert.strictEqual(isActionableTarget({ ...live, targetPricePerUnit: null }, DURING_N3VH), false);
assert.strictEqual(isActionableTarget(null, DURING_N3VH), false);
ok('actionability needs a number, a future deadline and an unsettled status');

console.log(`\n${checks}/${checks} checks passed`);
