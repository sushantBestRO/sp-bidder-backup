'use strict';
/**
 * walk-report.js - read-only ops report on the final-window walk's timing, from closedBids.
 *
 *   node scripts/walk-report.js [--data-dir <dir>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--platform sp|gocomet]
 *
 * Per closed load: lane, shipper, platform, close model, close time (IST), and for each of our bids the
 * seconds before close at decision, at accept and when its rank became visible, the rank seen, accepted
 * or refused (with the portal's reason), then the final rank and whether it was won. Per day and
 * platform: last-bid seconds before close (p50/p85/p99), loads at rank 1 at close, loads the walk ran on
 * that stopped at rank 1 above their lowest price, and walks that hit the deadline (outranked too late).
 *
 * Our own timing and rank only; no rival price is read or printed. Read-only: closedBids.json is read
 * straight from disk and never renamed, repaired or written, even when it cannot be parsed.
 */
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { percentile } = require('../src/engine/walkTiming');

const IST_MS = 330 * 60_000;

function args(argv) {
  const a = { dataDir: path.join(__dirname, '..', 'data'), from: null, to: null, platform: null };
  for (let i = 2; i < argv.length; i++) {
    const v = () => argv[++i];
    if (argv[i] === '--data-dir') a.dataDir = v();
    else if (argv[i] === '--from') a.from = Date.parse(`${v()}T00:00:00+05:30`);
    else if (argv[i] === '--to') a.to = Date.parse(`${v()}T23:59:59.999+05:30`);
    else if (argv[i] === '--platform') a.platform = v();
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return a;
}

const ist = (ms) => (Number.isFinite(ms) ? new Date(ms + IST_MS).toISOString().replace('T', ' ').slice(0, 19) : '-');
const day = (ms) => (Number.isFinite(ms) ? new Date(ms + IST_MS).toISOString().slice(0, 10) : 'unknown');
const s1 = (ms) => (Number.isFinite(ms) ? (ms / 1000).toFixed(1) : '-');
const lane = (l) => (l && typeof l === 'object' ? `${l.origin || '?'} -> ${l.destination || '?'}` : String(l || '-'));
const platformOf = (r) => (r.platformKey === config.gocomet.platformKey ? 'gocomet' : 'sp');

function bidRows(rec) {
  const rows = [];
  for (const b of rec.ourBids || []) {
    const left = Number(b.closesInMs);
    const since = (t) => (Number.isFinite(t) && Number.isFinite(b.decidedAt) && Number.isFinite(left) ? left - (t - b.decidedAt) : null);
    rows.push({ at: b.decidedAt || b.ts, decision: Number.isFinite(left) ? left : null, accept: since(b.writeLandedAt),
      rankVisible: since(b.rankVisibleAt), rank: b.socketRank != null ? b.socketRank : b.rank, outcome: 'accepted', price: b.price });
  }
  for (const r of rec.rejectedBids || []) {
    rows.push({ at: r.ts, decision: Number.isFinite(Number(r.closesInMs)) ? Number(r.closesInMs) : null, accept: null,
      rankVisible: null, rank: null, outcome: `refused: ${String(r.reason || r.body || 'no reason').slice(0, 80)}`, price: r.price });
  }
  return rows.sort((x, y) => (x.at || 0) - (y.at || 0));
}

async function main() {
  const a = args(process.argv);
  const file = path.join(a.dataDir, 'closedBids.json');
  let all = [];
  if (fs.existsSync(file)) {
    try {
      all = Object.values(JSON.parse(fs.readFileSync(file, 'utf8')) || {});
    } catch (e) {
      console.error(`closedBids.json could not be parsed (${e.message}); nothing was changed on disk`);
      process.exitCode = 1;
      return;
    }
  }
  const closed = all.filter((r) => r && r.status === 'closed'
    && (a.from == null || (r.closedAt || 0) >= a.from) && (a.to == null || (r.closedAt || 0) <= a.to)
    && (!a.platform || platformOf(r) === a.platform))
    .sort((x, y) => (x.closedAt || 0) - (y.closedAt || 0));

  const days = new Map();
  for (const rec of closed) {
    const p = platformOf(rec);
    console.log(`\n${rec.auctionId}  ${lane(rec.lane)}  ${rec.shipper || '-'}  ${p}  ${rec.closeModel || '-'}  closes ${ist(rec.closedAt)} IST`);
    console.log('  s before close: decision / accept / rank visible | rank | outcome');
    const rows = bidRows(rec);
    for (const r of rows) console.log(`  ${s1(r.decision).padStart(7)} / ${s1(r.accept).padStart(7)} / ${s1(r.rankVisible).padStart(7)} | ${r.rank != null ? r.rank : '-'} | ${r.outcome}`);
    const miss = rec.walkTimingMiss ? `; outranked too late to step at ${s1(rec.walkTimingMiss.remainingMs)} s` : '';
    console.log(`  final rank ${rec.finalRank != null ? rec.finalRank : '-'}, ${rec.won === true ? 'won' : rec.won === false ? 'not won' : 'result unknown'}${miss}`);

    const key = `${day(rec.closedAt)} ${p}`;
    const d = days.get(key) || { loads: 0, lastBid: [], rank1: 0, stoppedAtL1: 0, hitDeadline: 0 };
    d.loads += 1;
    const landed = rows.filter((r) => r.outcome === 'accepted');
    const last = landed[landed.length - 1];
    if (last) d.lastBid.push(last.accept != null ? last.accept : last.decision);
    if (rec.finalRank === 1) d.rank1 += 1;
    const ladder = Array.isArray(rec.ladder) ? rec.ladder : [];
    const walked = (rec.ourBids || []).some((b) => b && b.walk != null);
    if (walked && rec.finalRank === 1 && last && ladder.length && last.price > ladder[ladder.length - 1]) d.stoppedAtL1 += 1;
    if (rec.walkTimingMiss) d.hitDeadline += 1;
    days.set(key, d);
  }

  console.log('\nday        platform  loads  last bid s before close p50/p85/p99  rank 1 at close  stopped at L1  hit deadline');
  for (const [key, d] of [...days.entries()].sort()) {
    const [dd, p] = key.split(' ');
    const q = (n) => s1(percentile(d.lastBid.filter(Number.isFinite), n));
    console.log(`${dd} ${p.padEnd(9)} ${String(d.loads).padStart(5)}  ${`${q(50)} / ${q(85)} / ${q(99)}`.padEnd(38)} ${String(d.rank1).padStart(15)} ${String(d.stoppedAtL1).padStart(14)} ${String(d.hitDeadline).padStart(13)}`);
  }
  if (!closed.length) console.log('(no closed loads in range)');
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
