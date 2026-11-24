'use strict';
/**
 * Soft-close IDLE-TAIL measurement - the production verification for the v2.6.1 soft-close fix.
 *
 * WHY THIS FILE EXISTS
 * The 2026-08-01 incident analysis was run ad-hoc and its filter predicate was never written
 * down - only its outputs were (64 loads / 23.4% / Rs 1,83,266). Those outputs cannot now be
 * reproduced from closedBids.json, because nobody can say exactly which loads they selected.
 * That number was headed for a client conversation. So from here the predicate lives in code,
 * the measurement is one command, and scripts/test-softclose-idle-tail-measure.js pins the
 * arithmetic against a fixture so it cannot drift silently the way the last one did.
 *
 * THE MEASURE
 *   idleTail = closedAt - (last WRITE ATTEMPT on the load)
 * A write attempt is any entry in ourBids[] (landed) OR rejectedBids[] (refused by SuperProcure).
 * Rejected attempts COUNT: the question is "when did the engine last TRY to move", not "when did
 * it last succeed". Including them is what reproduces the published baseline table exactly -
 * soft n=272 median 186s max 931s, hard n=573 median 2s max 29s. Counting only landed bids gives
 * soft n=258 median 217s, which does not match. This is the single easiest thing to get wrong.
 *
 * WHY THE IDLE TAIL IS THE DISCRIMINATOR
 * Pre-fix the two close models did not overlap AT ALL: every hard-close load bid within 29s of
 * its close, every soft-close load was silent for more than 60s. A soft distribution that moves
 * toward the hard one is the fix working. That is the headline number.
 *
 * USAGE
 *   node scripts/measure-softclose-idle-tail.js [--file <closedBids.json>] [--since <ISO8601>]
 * Defaults to this app's own data/closedBids.json, so on the box it runs with no arguments.
 * --since splits the corpus into BEFORE (baseline) and ON/AFTER (window) and prints both.
 * Read-only: opens one JSON file, writes nothing, touches no network. Safe on production.
 */

const fs = require('fs');
const path = require('path');

const DEPLOY_V261 = '2026-08-01T16:36:39Z'; // bid-command pm_uptime after the v2.6.1 deploy
const IDLE_TAIL_GATE_S = 60;                // hard-close loads never exceed 29s; 60s is 2x that

// ---- the measure (pure; exported for the test) -----------------------------

/** Every write ATTEMPT on a load - landed bids and platform-refused bids alike. */
function writeTimes(doc) {
  return [
    ...((doc && doc.ourBids) || []).map((b) => b.ts),
    ...((doc && doc.rejectedBids) || []).map((b) => b.ts),
  ].filter((t) => Number.isFinite(t));
}

/** Seconds between the last write attempt and the close. null when the engine never wrote. */
function idleTailS(doc) {
  const w = writeTimes(doc);
  if (!w.length || !Number.isFinite(doc && doc.closedAt)) return null;
  return (doc.closedAt - Math.max(...w)) / 1000;
}

/**
 * Did any LANDED bid reach the desk-approved floor (the last rung of the ladder)?
 * null when unanswerable - no landed bids, or no floor recorded.
 */
function floorOffered(doc) {
  const b = (doc && doc.ourBids) || [];
  if (!b.length || !doc || doc.floor == null) return null;
  return Math.min(...b.map((x) => x.price)) <= doc.floor;
}

/** Authorised headroom left on the table: how far the last bid stayed above the floor. */
function headroom(doc) {
  return doc && doc.lastBidPrice != null && doc.floor != null ? doc.lastBidPrice - doc.floor : 0;
}

/**
 * Q - the defect population. The engine landed a bid, then went quiet while the auction was
 * still live, never put the approved floor on the board, and lost.
 * Caller filters to soft close; this predicate is close-model agnostic on purpose so the test
 * can assert it does NOT fire on the hard-close shape.
 */
function qualifies(doc) {
  return ((doc && doc.ourBids) || []).length > 0
    && floorOffered(doc) === false
    && doc.won !== true
    && (idleTailS(doc) || 0) > IDLE_TAIL_GATE_S;
}

// ---- stats -----------------------------------------------------------------

function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const pct = (n, d) => (d ? (100 * n) / d : 0);

/** The full picture for one population of docs, as data. Rendering is separate. */
function summarize(docs) {
  const closed = docs.filter((d) => d && d.closedAt);
  const byModel = (m) => closed.filter((d) => d.closeModel === m && writeTimes(d).length);
  const soft = byModel('soft');
  const hard = byModel('hard');
  const tails = (pop) => pop.map(idleTailS).filter((t) => t != null);
  const dist = (pop) => {
    const t = tails(pop);
    return {
      n: t.length,
      median: t.length ? median(t) : NaN,
      max: t.length ? Math.max(...t) : NaN,
      over30: t.filter((x) => x > 30).length,
      over60: t.filter((x) => x > 60).length,
    };
  };
  const q = soft.filter(qualifies);
  return {
    closed: closed.length,
    soft: dist(soft),
    hard: dist(hard),
    q: {
      n: q.length,
      softN: soft.length,
      rate: pct(q.length, soft.length),
      money: q.reduce((s, d) => s + headroom(d), 0),
      medianHeadroom: q.length ? median(q.map(headroom)) : NaN,
      medianTail: q.length ? median(q.map(idleTailS)) : NaN,
      maxTail: q.length ? Math.max(...q.map(idleTailS)) : NaN,
      byShipper: q.reduce((m, d) => { m[d.shipper] = (m[d.shipper] || 0) + 1; return m; }, {}),
      softByShipper: soft.reduce((m, d) => { m[d.shipper] = (m[d.shipper] || 0) + 1; return m; }, {}),
    },
  };
}

module.exports = {
  writeTimes, idleTailS, floorOffered, headroom, qualifies, median, summarize,
  DEPLOY_V261, IDLE_TAIL_GATE_S,
};

// ---- CLI -------------------------------------------------------------------
if (require.main !== module) return;

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const FILE = arg('--file', path.join(__dirname, '..', 'data', 'closedBids.json'));
const SINCE_ISO = arg('--since', DEPLOY_V261);
const SINCE = Date.parse(SINCE_ISO);
if (!Number.isFinite(SINCE)) { console.error(`bad --since: ${SINCE_ISO}`); process.exit(1); }
if (!fs.existsSync(FILE)) { console.error(`no such file: ${FILE}\npass --file <closedBids.json>`); process.exit(1); }

const docs = Object.values(JSON.parse(fs.readFileSync(FILE, 'utf8')));

const row = (label, d) => (d.n === 0 ? `  ${label.padEnd(6)} n=0`
  : `  ${label.padEnd(6)} n=${String(d.n).padStart(4)}  median=${d.median.toFixed(0).padStart(4)}s  max=${d.max.toFixed(0).padStart(4)}s`
    + `  >30s=${String(d.over30).padStart(4)} (${pct(d.over30, d.n).toFixed(1).padStart(5)}%)`
    + `  >60s=${String(d.over60).padStart(4)} (${pct(d.over60, d.n).toFixed(1).padStart(5)}%)`);

function report(title, pop) {
  const s = summarize(pop);
  console.log(`\n=== ${title} ===`);
  console.log(`  closed docs: ${s.closed}   soft(with writes): ${s.soft.n}   hard(with writes): ${s.hard.n}`);
  if (!s.closed) { console.log('  NO DATA IN THIS WINDOW - nothing to measure.'); return null; }
  console.log('\n  idle tail (closedAt - last write attempt, rejected attempts included):');
  console.log(row('hard', s.hard));
  console.log(row('soft', s.soft));
  console.log(`\n  Q (soft, landed, floor never offered, lost, tail>${IDLE_TAIL_GATE_S}s):`);
  console.log(`    n=${s.q.n} of ${s.q.softN} soft = ${s.q.rate.toFixed(1)}%`);
  if (s.q.n) {
    console.log(`    idle tail median=${s.q.medianTail.toFixed(0)}s max=${s.q.maxTail.toFixed(0)}s`);
    console.log(`    unoffered headroom: total=Rs ${s.q.money.toLocaleString('en-IN')}  median=Rs ${s.q.medianHeadroom.toLocaleString('en-IN')}`);
    console.log('    per customer:');
    for (const k of Object.keys(s.q.byShipper).sort((a, b) => s.q.byShipper[b] - s.q.byShipper[a])) {
      console.log(`      ${String(k).trim().padEnd(36)} ${String(s.q.byShipper[k]).padStart(3)} / ${String(s.q.softByShipper[k]).padStart(3)}  (${pct(s.q.byShipper[k], s.q.softByShipper[k]).toFixed(0)}%)`);
    }
  }
  return s;
}

console.log(`file:   ${FILE}`);
console.log(`docs:   ${docs.length}`);
console.log(`--since ${new Date(SINCE).toISOString()}  (v2.6.1 deploy = ${DEPLOY_V261})`);

const b = report('BASELINE - closed BEFORE the cutoff (pre-fix)', docs.filter((d) => d.closedAt && d.closedAt < SINCE));
const a = report('WINDOW - closed ON/AFTER the cutoff (post-fix)', docs.filter((d) => d.closedAt && d.closedAt >= SINCE));

console.log('\n=== VERDICT ===');
if (!a) {
  const closed = docs.filter((d) => d.closedAt);
  const last = closed.length ? Math.max(...closed.map((d) => d.closedAt)) : null;
  console.log(`  NOT MEASURABLE YET - zero loads have closed since ${new Date(SINCE).toISOString()}.`);
  if (last) {
    console.log(`  Latest close in the corpus: ${new Date(last).toISOString()}`);
    console.log(`  (${((SINCE - last) / 3600000).toFixed(1)}h BEFORE the cutoff - the fix has not yet seen a live close.)`);
  }
} else if (b) {
  const d = a.q.rate - b.q.rate;
  console.log(`  Q-rate  baseline ${b.q.rate.toFixed(1)}%  ->  window ${a.q.rate.toFixed(1)}%   (${d >= 0 ? '+' : ''}${d.toFixed(1)} pts)`);
  console.log(`  soft idle-tail median  ${b.soft.median.toFixed(0)}s -> ${a.soft.median.toFixed(0)}s   (hard reference: ${a.hard.n ? `${a.hard.median.toFixed(0)}s` : 'n/a'})`);
  console.log(`  window n=${a.soft.n} soft loads. Under ~40 this is indicative, not conclusive.`);
}

console.log(`
--- READ THIS BEFORE QUOTING ANY NUMBER ---
The published incident figures were 64 loads / 23.4% of closed soft loads / Rs 1,83,266, split
Havells 40, Dynamic Cables 10, Renewsys 11, Epack 3, Payal Polyplast 0. They are NOT reproduced by
the Q predicate above, and no predicate tried reproduces that per-customer split - Q matches four
of the five customers exactly and differs only on Havells (129 vs 40).

The headline TABLE above IS reproduced exactly against the 2026-08-01 corpus, so the corpus and the
tail measure are right; it is the money-subset filter that was lost. Compare Q against Q. Do not
compare Q against the 64.
`);
