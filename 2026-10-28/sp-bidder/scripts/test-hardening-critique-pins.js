'use strict';
/**
 * Pins for two gaps the mutation critique found in the PR-4 engine guards (both survived every
 * existing test).
 *
 * 1-2. A server fault is any status from 500 up, 500 itself included. The 5xx guard in
 *      rejectionMatch was pinned only with a 503, so `>= 500` weakened to `> 500` went unnoticed:
 *      a plain HTTP 500 whose body carries the submission-closed wording would stand a live load
 *      down for good. Check 2 is the control: the same body at a 4xx still latches.
 * 3-4. The rehydrate retire-failed alert is keyed on the set of failed loads, not on the order the
 *      sweep met them in. Two restarts stranding the same loads must carry one identity, or the
 *      notifier's dedupe sends the same alert again on every restart. Check 4 is the control: a
 *      different set still carries a different identity.
 * 5.   The outbid message names the shipper. Its rank slot was made total in this release, and the
 *      shipper slot on the same line was left without a check.
 *
 * Run: node scripts/test-hardening-critique-pins.js
 */
process.env.LOG_LEVEL = 'silent';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

let pass = 0;
const EXPECTED_CHECKS = 5;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-critique-'));
process.on('exit', () => { try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch (_) {} });
let seq = 0;

const CLOSED_BODY = 'Auction has already ended for this load';
const HOUR = 3_600_000;

function liveEngine() {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
  };
  return new BidEngine(adapter, new DurableScheduler(path.join(TMPDIR, `intent-${seq++}.json`)), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 }, softClose: { enabled: false } });
}

function armed(eng) {
  const m = eng.arm({ id: 'CRIT-5XX', lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1, equipment: '32ft',
    companyName: 'Acme Test Co', branchName: 'Alwar', closesAt: Date.now() + 600_000 },
  { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = [10_000, 9_700];
  m.floor = 9_700;
  m.closeModel = 'hard';
  m.revisionsLeft = 30;
  return m;
}

async function closedWordingAt(status) {
  const eng = liveEngine();
  const m = armed(eng);
  eng.adapter.placeBid = async () => ({ accepted: false, status, reason: CLOSED_BODY, text: CLOSED_BODY });
  await eng._maybeBid(m, { closesInMs: 20_000, myRank: null, minDecrement: 100, standingL1Price: null, measuredRttMs: 50 });
  eng.kill('done');
  return m.submissionClosed;
}

const quietAdapter = {
  capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'soft' }),
  ensureSession: async () => ({}),
  writeEnabled: false,
  async getAuctionState() { return { ok: false }; },
  async placeBid() { return { accepted: false }; },
};

async function failedRetireIdentity(ids) {
  const intents = ids.map((id) => ({ auctionId: id, status: 'bidding', closesAt: Date.now() - 2 * HOUR, won: null,
    lane: { origin: 'Bhiwandi', destination: 'Hosur' }, units: 1, cost: 50_000, marginsPct: [12.6, 7.2, 6.3] }));
  const scheduler = {
    activeIntents: () => intents.slice(),
    get: (id) => intents.find((i) => i.auctionId === id) || null,
    update: () => { throw new Error('ENOSPC: no space left on device'); },
  };
  const alerts = [];
  const eng = new BidEngine(quietAdapter, scheduler, { onEvent: (e) => { if (e.type === 'alert') alerts.push(e); } });
  await eng.rehydrate();
  const a = alerts.find((e) => e.kind === 'rehydrate_retire_failed');
  assert.ok(a, `precondition: the retire-failed alert fired for [${ids.join(', ')}]`);
  return a.auctionId;
}

(async () => {
  assert.strictEqual(await closedWordingAt(500), false,
    'an HTTP 500 is a server fault, not a platform verdict: the submission-closed wording must not latch');
  ok('1. a plain 500 carrying the submission-closed wording does not stand the load down');

  assert.strictEqual(await closedWordingAt(400), true, 'CONTROL: the same wording at a 400 is a real verdict and latches');
  ok('2. control: the same wording at a 400 still latches');

  const forward = await failedRetireIdentity(['LOAD-A', 'LOAD-B']);
  const reversed = await failedRetireIdentity(['LOAD-B', 'LOAD-A']);
  assert.strictEqual(reversed, forward,
    `the same stranded loads met in a different order must carry one identity (got ${forward} and ${reversed})`);
  ok('3. the retire-failed alert identity does not depend on the order the sweep met the loads');

  const other = await failedRetireIdentity(['LOAD-A', 'LOAD-C']);
  assert.notStrictEqual(other, forward, 'CONTROL: a different stranded set carries a different identity');
  ok('4. control: a different stranded set still carries a different identity');

  const outbid = { lane: 'Bhiwandi -> Alwar', shipper: 'Acme Test Co', rank: 3 };
  const body = renderMessage(templateFor('outbid', outbid), outbid);
  assert.ok(body.includes('(Acme Test Co)') && body.includes('rank 3'),
    `the outbid message must name the shipper and the rank; got: ${body}`);
  ok('5. the outbid message names the shipper beside the rank');

  if (pass !== EXPECTED_CHECKS) { console.error(`ran ${pass} of ${EXPECTED_CHECKS} checks`); process.exit(1); }
  console.log(`\nPASS ${pass}/${EXPECTED_CHECKS} checks passed`);
})().catch((e) => { console.error('FAILED: ' + (e && e.message)); process.exit(1); });
