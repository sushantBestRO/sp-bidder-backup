'use strict';
/**
 * scripts/backfill-sp-final-rank.js, offline from the redacted PENDING v4 fixture.
 *
 * Dry-run writes nothing and states the count; --apply refuses without the matching --expect; a
 * matching apply books finalRank/won on exactly the SP records whose load carries our active row,
 * leaves every other record byte-identical, and a re-run finds nothing left to change.
 *
 *   node scripts/test-backfill-sp-final-rank.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'backfill-sp-final-rank.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'sp-v4-pending-epack-2026-09-28.json');

const closedAt = Date.parse('2026-09-28T06:00:00Z');
const bid = (price) => ({ price, rungIndex: 0, rank: null, socketRank: null, ts: closedAt - 60_000 });
const base = (id, extra = {}) => ({ auctionId: id, shipper: 'Epack Prefab Technologies Limited', ourBids: [bid(70000)],
  lastBidPrice: 70000, finalRank: null, won: false, status: 'closed', closedAt, resultReason: 'unknown', ...extra });

const RECORDS = {
  25903462: base('25903462', { ourBids: [bid(75040), bid(73500)], lastBidPrice: 73500 }),
  25840948: base('25840948', { account: { accountId: 'suyash-gupta', label: 'suyash-gupta' } }),
  25913499: base('25913499', { won: null }),
  25905527: base('25905527', { ourBids: [bid(38850)], lastBidPrice: 38850 }),
  25903199: base('25903199', { ourBids: [] }),
  22222222: base('22222222'),
  25916568: base('25916568', { finalRank: 4 }),
  25787460: base('25787460', { closedAt: Date.parse('2026-09-10T06:00:00Z') }),
  25761228: base('25761228', { platformKey: 'gocomet' }),
  25836105: base('25836105', { status: 'open', closedAt: null }),
};

let checks = 0;
const failures = [];
function check(label, fn) {
  checks++;
  try { fn(); console.log(`  ok  ${checks}. ${label}`); }
  catch (e) { failures.push(`${checks}. ${label} - ${String(e && e.message).split('\n')[0]}`); console.error(`  FAIL ${checks}. ${label} - ${e && e.message}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-sp-rank-'));
const file = path.join(dir, 'closedBids.json');
fs.writeFileSync(file, JSON.stringify(RECORDS, null, 2));
const run = (...extra) => spawnSync(process.execPath,
  [SCRIPT, '--since=2026-09-18', `--data-dir=${dir}`, `--v4-file=${FIXTURE}`, ...extra], { encoding: 'utf8' });
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));

try {
  const before = fs.readFileSync(file, 'utf8');
  const dry = run();
  check('dry-run exits 0', () => assert.strictEqual(dry.status, 0, dry.stderr + dry.stdout));
  check('dry-run writes nothing', () => assert.strictEqual(fs.readFileSync(file, 'utf8'), before));
  check('dry-run prints old -> new for the three rank-1 loads and the rank-4 load', () => {
    assert.match(dry.stdout, /25903462\s+finalRank null -> 1\s+won false -> true/);
    assert.match(dry.stdout, /25840948\s+finalRank null -> 1\s+won false -> true/);
    assert.match(dry.stdout, /25913499\s+finalRank null -> 1\s+won null -> true/);
    assert.match(dry.stdout, /25905527\s+finalRank null -> 4\s+won false -> false/);
  });
  check('dry-run states the count and how to apply it', () => {
    assert.match(dry.stdout, /4 record\(s\) would change/);
    assert.match(dry.stdout, /--apply --expect=4/);
  });
  check('dry-run reports the SP record it could not settle', () => {
    assert.match(dry.stdout, /22222222\s+unchanged/);
  });

  const noExpect = run('--apply');
  check('--apply without --expect refuses and writes nothing', () => {
    assert.notStrictEqual(noExpect.status, 0, noExpect.stdout);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  });
  const wrong = run('--apply', '--expect=3');
  check('--apply with a surprising count refuses and writes nothing', () => {
    assert.notStrictEqual(wrong.status, 0, wrong.stdout);
    assert.match(wrong.stdout + wrong.stderr, /expected 3/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  });

  const applied = run('--apply', '--expect=4');
  const after = read();
  check('--apply with the matching count exits 0', () => assert.strictEqual(applied.status, 0, applied.stderr + applied.stdout));
  check('the three rank-1 loads are booked won at rank 1', () => {
    for (const id of ['25903462', '25840948', '25913499']) {
      assert.deepStrictEqual([after[id].finalRank, after[id].won, after[id].resultReason], [1, true, 'won'], id);
    }
  });
  check('the rank-4 load is booked lost at rank 4', () => {
    assert.deepStrictEqual([after['25905527'].finalRank, after['25905527'].won], [4, false]);
  });
  check('each changed record keeps what it replaced and the amount SP showed', () => {
    assert.deepStrictEqual(after['25903462'].finalRankBackfill.previous, { finalRank: null, won: false });
    assert.strictEqual(after['25903462'].finalRankBackfill.amount, 73500);
    assert.strictEqual(after['25903462'].finalRankBackfill.source, 'sp_v4_pending');
  });
  check('every other record is untouched', () => {
    for (const id of ['25903199', '22222222', '25916568', '25787460', '25761228', '25836105']) {
      assert.deepStrictEqual(after[id], RECORDS[id], id);
    }
  });
  const again = run();
  check('a re-run finds nothing left to change', () => {
    assert.strictEqual(again.status, 0, again.stderr);
    assert.match(again.stdout, /0 record\(s\) would change/);
  });
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} of ${checks} checks:`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`\nPASS: all ${checks} checks - the back-fill books the PENDING rank and nothing else`);
