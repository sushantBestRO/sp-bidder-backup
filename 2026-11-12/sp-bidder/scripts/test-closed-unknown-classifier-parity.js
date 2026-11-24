'use strict';
/**
 * The won/unknown/lost rule exists in FIVE copies. One orphan, one answer, everywhere.
 *
 * THE RISK THIS PINS. Nothing in the codebase makes these five agree - each surface re-implements
 * the same three-way classification against its own projection of the same closed-bids record:
 *
 *   1. src/web/exportModel.js          deriveStatus          (the console + both downloads)
 *   2. scripts/report-participation.js deriveStatus          (the funnel spine)
 *   3. scripts/report-participation.js buildOutcomeRows      (the full-history outcome rollup)
 *   4. src/notify/directorEod.js       deriveStatus          (the Director's evening message)
 *   5. src/notify/eodReport.js         collectCustomerDay    (each customer's group message)
 *
 * Five copies is five chances for one of them to drift back to the binary rule, and the drift is
 * invisible: every surface still renders, each just answers a different question about the same
 * auction. Copy 3 was already missed once - the funnel spine is a rolling ~7-day window, so an
 * auction older than that appears ONLY in the outcome rollup, which is exactly where retired orphans
 * accumulate.
 *
 * So this feeds ONE ledger document - the shape bidLogger actually writes for a retired orphan -
 * through all five, each via its own production projection, and asserts they return one answer. The
 * mirror case (a genuine fought loss) runs the same route, because a rule that answered 'unknown'
 * unconditionally would satisfy the first half alone.
 *
 * Copies 4 and 5 are driven through their COLLECTORS rather than their classifiers, because on both
 * the projection is the drift surface: directorEod's `closed` object was narrower than the
 * classifier it feeds until this change widened it, and a projection that drops closedWhileDown
 * silently makes the branch below it unreachable while the classifier itself still reads correct.
 *
 *   node scripts/test-closed-unknown-classifier-parity.js
 */
const assert = require('assert');
const { createStore } = require('../src/store');
const exportModel = require('../src/web/exportModel');
const reportParticipation = require('./report-participation');
const directorEod = require('../src/notify/directorEod');
const eodReport = require('../src/notify/eodReport');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const NOW = Date.now();
const CLOSED_AT = NOW - 3_600_000;
const PORTAL = 'gocomet';

/**
 * THE ONE FACT. A closed-bids record exactly as bidLogger leaves it after a retirement: real bids on
 * the board, the flag set, and nothing that says how the auction ended. `over` produces the mirror
 * cases from the same base, so no case can differ from another in a way nobody wrote down.
 */
const ledgerDoc = (over = {}) => Object.assign({
  auctionId: 'GC-1', platformKey: PORTAL, shipper: 'Waaree Energies',
  lane: { origin: 'Bhiwandi', destination: 'Hosur' }, equipment: '32ft SXL', units: 1,
  cost: 50_000, ladder: [56_300, 53_600, 53_150], floor: 53_150,
  ourBids: [{ price: 56_300, rungIndex: 0, rank: null, ts: CLOSED_AT - 60_000 }],
  lastBidPrice: 56_300,
  finalRank: null, won: null, closedWhileDown: true,
  closeModel: 'soft', closedAt: CLOSED_AT, armedAt: CLOSED_AT - 3_600_000,
  status: 'closed',
}, over);

/**
 * The price request the same load surfaced as - the join partner every collector starts from.
 *
 * createdAt is NOW exactly, not an hour ago: directorEod's cohort is the IST calendar day, so any
 * backdated timestamp drops the load out of the cohort for the minutes right after IST midnight and
 * the parity assertion would flake once a day. NOW is inside the day containing NOW, always.
 */
const priceReq = (over = {}) => Object.assign({
  loadId: 'GC-1', platformKey: PORTAL, status: 'closed',
  createdAt: NOW, capturedAt: NOW,
  load: { companyName: 'Waaree Energies', lane: { origin: 'Bhiwandi', destination: 'Hosur' },
    equipment: '32ft SXL', units: 1, branchName: null, closesAt: CLOSED_AT },
}, over);

// ---- the production projections, transcribed from their own call sites -------------------------
// Copies 2 and 3 read a normalized row, not the raw doc. This is loadFromDataDir's mapping (the same
// one loadFromApi applies), so the test feeds them what the report itself would feed them.
const participationRow = (doc) => ({
  loadId: String(doc.auctionId), company: doc.shipper || '',
  numBids: Array.isArray(doc.ourBids) ? doc.ourBids.length : 0,
  won: !!doc.won, finalRank: doc.finalRank,
  closedWhileDown: doc.closedWhileDown === true,
  closeModel: doc.closeModel || null, closedAt: doc.closedAt,
});

/** Every collector shares these two seams; the store is rebuilt per case so nothing carries over. */
async function collectorsFor(doc, req) {
  const store = createStore({ backend: 'memory' });
  await store.putDoc('closedBids', String(doc.auctionId), doc);
  const requests = { listAll: async () => [req] };
  const director = await directorEod.collectDirectorDay({
    requests, store, customers: [], now: NOW,
  });
  const customer = await eodReport.collectCustomerDay({
    requests, store, aliases: [], origins: [], branches: [],
    windowStart: NOW - 86_400_000, windowEnd: NOW + 1, now: NOW,
  });
  return { director, customer };
}

/**
 * The five answers for one document, each named by its site so a failure says WHICH copy drifted.
 * Copies 4 and 5 do not return a status string - they bucket. Their answer is which bucket the load
 * landed in, which is the same claim expressed as a count.
 */
async function answersFor(doc) {
  const req = priceReq();
  const row = participationRow(doc);
  const { director, customer } = await collectorsFor(doc, req);
  const bucket = (won, lost, unknown) => (unknown ? 'closed_unknown' : (won ? 'won' : (lost ? 'lost' : 'NO BUCKET')));
  return {
    'exportModel.deriveStatus': exportModel.deriveStatus(req, doc),
    'report-participation.deriveStatus': reportParticipation.deriveStatus(req.status, row),
    'report-participation.buildOutcomeRows': reportParticipation.buildOutcomeRows([row])[0].status,
    'directorEod.collectDirectorDay': bucket(director.won, director.lost,
      director.won === 0 && director.lost === 0 && director.bid === 1),
    'eodReport.collectCustomerDay': bucket(customer.won, customer.lostDecided, customer.closedUnknown),
  };
}

function assertParity(answers, expected, label) {
  for (const [site, got] of Object.entries(answers)) {
    ok(got === expected, `${label}: ${site} answers '${expected}' (got '${got}')`);
  }
  const distinct = new Set(Object.values(answers));
  ok(distinct.size === 1,
    `${label}: all five copies return ONE answer (got ${JSON.stringify([...distinct])})`);
}

(async () => {
  // ---- the orphan: flagged, bid, no rank -> unknown, on every surface --------------------------
  assertParity(await answersFor(ledgerDoc()), 'closed_unknown', 'orphan');

  // ---- the mirror: a fought loss must still be a loss, on every surface ------------------------
  // Without this half, a copy hard-wired to 'closed_unknown' would pass the block above.
  assertParity(await answersFor(ledgerDoc({ closedWhileDown: false, won: false, finalRank: 4 })),
    'lost', 'fought loss');

  // ---- the case that separates the flag from the rank -------------------------------------------
  // rehydrate PRESERVES a rank when the record already carried one, and a preserved rank is a
  // settled outcome. Both halves of the rule are load-bearing, and a copy that read only the flag
  // would turn a known loss back into doubt.
  assertParity(await answersFor(ledgerDoc({ closedWhileDown: true, won: false, finalRank: 4 })),
    'lost', 'flagged but rank preserved');

  const EXPECTED_CHECKS = 18;
  assert.strictEqual(fail, 0, `${fail} classifier-parity checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
