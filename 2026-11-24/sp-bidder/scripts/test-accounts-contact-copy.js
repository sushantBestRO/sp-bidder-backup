'use strict';
/**
 * BC-09: the Accounts page's "not on the team" line was read by BRL as "the master login gets
 * no alerts", not as a statement about the login's CONTACT PERSON.
 *
 * Root cause: the sentence's subject was the pronoun "it", which resolves as easily to the whole
 * account/login as to the contact - "Not on the team, so it gets no bid alerts." A reader who has
 * not traced personOnPhone has no way to tell which "it" is meant, and BRL read the wrong one.
 *
 * Fix: name the subject. "This contact" cannot be misread as the account or its bidding, only as
 * the person the login's phone/email belongs to.
 *
 * Regression target: BC-09.
 *
 * Offline and deterministic: reads source only.
 *
 *   node scripts/test-accounts-contact-copy.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGE = 'dashboard/src/pages/Accounts.tsx';

function stripComments(src) {
  const noLine = src
    .split('\n')
    .map((line) => {
      const i = line.search(/(^|[^:])\/\//);
      if (i < 0) return line;
      return line.slice(0, line.indexOf('//', i));
    })
    .join('\n');
  return noLine.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

const src = stripComments(fs.readFileSync(path.join(ROOT, PAGE), 'utf8'));

const OLD = /Not on the team, so it gets no bid alerts\./g;
const NEW = /Not on the desk team, so this contact gets no bid alerts\./g;

const results = [];
const check = (n, desc, fn) => {
  try { fn(); results.push({ n, ok: true }); }
  catch (e) { results.push({ n, ok: false }); console.error(`  FAIL ${n}. ${desc}: ${e.message}`); }
};

check(1, 'the ambiguous "it" wording is gone', () => {
  const hits = src.match(OLD) || [];
  assert.strictEqual(hits.length, 0, `still present ${hits.length} time(s) - "it" can still be read as the login/account`);
});

check(2, 'the reworded line names the contact explicitly, on both branches (phone and email-only)', () => {
  const hits = src.match(NEW) || [];
  assert.strictEqual(hits.length, 2, `found ${hits.length}, expected 2 (the phone-case branch and the email-only fallback)`);
});

check(3, 'the reworded line still says bid alerts, so the meaning is not lost', () => {
  assert.ok(/gets no bid alerts/i.test(src), 'no "gets no bid alerts" text found anywhere');
});

check(4, 'the reworded line never says "master"', () => {
  assert.ok(!/master/i.test(src), '"master" appears in the file - the copy should never name the account, only the contact');
});

check(5, 'the positive branch is unchanged: "On the team as" still renders the contact name', () => {
  assert.ok(/On the team as/.test(src), 'the positive "On the team as {name}" line has moved or is gone');
});

const EXPECTED = 5;
const failed = results.filter((r) => !r.ok).map((r) => r.n);
assert.strictEqual(results.length, EXPECTED, `expected ${EXPECTED} checks, ran ${results.length}`);
if (failed.length) {
  console.error(`FAIL: ${failed.length} of ${EXPECTED} checks (${failed.join(', ')}) - the Accounts contact line can still be misread as the account/master having no alerts`);
  process.exit(1);
}
console.log(`PASS: all ${EXPECTED} checks`);
