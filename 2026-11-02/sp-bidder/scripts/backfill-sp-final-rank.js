'use strict';

/**
 * backfill-sp-final-rank - book the settled rank on closed SuperProcure records whose finalRank is
 * null because the socket never ranked the load (the Epack logins), from the PENDING tab of
 * /sp/loads/v4, where our active bid row carries its final rank.
 *
 *   node scripts/backfill-sp-final-rank.js --since=2026-09-18                        # DRY-RUN, one read per account
 *   node scripts/backfill-sp-final-rank.js --since=2026-09-18 --v4-file=pending.json # DRY-RUN, offline
 *   node scripts/backfill-sp-final-rank.js --since=2026-09-18 --apply --expect=<N>   # write
 *   [--data-dir=<dir>] [--carrier=<id>]  (--carrier only matters offline, when rows are not on the load's carrier)
 *
 * A record qualifies when it is SuperProcure's, closed on or after --since, has finalRank null, and
 * carries a bid of ours (landed or refused). It changes only when its load is in PENDING with an
 * active row of ours holding a whole rank; every other qualifying record is printed as unchanged.
 * Loads already allotted or cancelled have left PENDING and cannot be recovered here.
 *
 * --apply refuses unless --expect equals the planned count, and writes each record through the
 * store's compare-and-set patch, so a record that changed since it was planned is refused, not
 * overwritten. Stop the service first (`pm2 stop bid-command`, by name only): it writes closedBids too.
 */

const path = require('path');
const fs = require('fs'); // allowed: ops script reading a saved v4 response, not app state
const { createStore } = require('../src/store');
const { platformOf } = require('../src/pricing/priceRequests');
const { resultReasonOf } = require('../src/util/reportedClose');
const { settledFromV4 } = require('../src/platform/realAdapter');

const COLLECTION = 'closedBids';

function usage(msg) {
  if (msg) console.error(msg);
  console.error('usage: node scripts/backfill-sp-final-rank.js --since=YYYY-MM-DD [--v4-file=<path>] [--data-dir=<dir>] [--carrier=<id>] [--apply --expect=<N>]');
  process.exit(2);
}

function parseArgs(argv) {
  const o = { since: null, v4File: null, dataDir: null, carriers: [], apply: false, expect: null };
  for (const a of argv) {
    const [k, v] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    if (k === '--since') o.since = v;
    else if (k === '--v4-file') o.v4File = v;
    else if (k === '--data-dir') o.dataDir = v;
    else if (k === '--carrier') o.carriers.push(Number(v));
    else if (k === '--apply') o.apply = true;
    else if (k === '--expect') o.expect = v;
    else usage(`unknown argument: ${a}`);
  }
  if (!o.since || !/^\d{4}-\d{2}-\d{2}$/.test(o.since)) usage('--since=YYYY-MM-DD is required');
  if (o.expect != null && !/^\d+$/.test(o.expect)) usage('--expect takes a whole number');
  if (o.carriers.some((c) => !Number.isFinite(c))) usage('--carrier takes a number');
  return o;
}

const attempted = (r) => (Array.isArray(r.ourBids) && r.ourBids.some(Boolean))
  || (Array.isArray(r.rejectedBids) && r.rejectedBids.some(Boolean));

function candidates(records, sinceMs, spKey) {
  return records.filter((r) => r && platformOf(r) === spKey && r.status === 'closed' && r.finalRank == null
    && Number(r.closedAt) >= sinceMs && attempted(r))
    .sort((a, b) => String(a.auctionId).localeCompare(String(b.auctionId)));
}

async function liveOutcomes(store, recs, since) {
  const config = require('../src/config');
  const { loadAccounts, resolveAccountToken } = require('../src/auth/accounts');
  const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
  const accounts = (await loadAccounts(store)).filter((a) => a.enabled !== false);
  const fallback = accounts.length === 1 ? accounts[0] : accounts.find((a) => a.accountId === 'primary') || null;
  const byAccount = new Map();
  for (const r of recs) {
    const acct = (r.account && accounts.find((a) => a.accountId === r.account.accountId)) || (r.account ? null : fallback);
    const key = acct ? acct.accountId : `unresolved:${(r.account && r.account.accountId) || '-'}`;
    if (!byAccount.has(key)) byAccount.set(key, { acct, ids: [] });
    byAccount.get(key).ids.push(String(r.auctionId));
  }
  const perLoad = new Map();
  for (const [key, { acct, ids }] of byAccount) {
    let got = null;
    let why = `account ${key} is not an enabled account on this box`;
    if (acct) {
      const adapter = new RealSuperProcureAdapter({
        token: resolveAccountToken(acct), headers: config.capturedHeaders,
        accountId: acct.accountId, accountLabel: acct.label || acct.accountId,
        apiBaseUrl: acct.apiBaseUrl || undefined, webOrigin: acct.webOrigin || undefined, authProbeEnabled: false,
      });
      try {
        await adapter.login();
        got = await adapter.readPendingOutcomes({ from: new Date(`${since}T00:00:00Z`) });
        why = `the PENDING read for account ${key} did not land`;
      } catch (e) {
        why = `login for account ${key} failed (${e && e.code ? e.code : 'error'})`;
      } finally {
        try { adapter.discard(); } catch (_) {}
      }
      if (got) console.log(`account ${key}: ${got.loads} load(s) in PENDING since ${since}`);
    }
    for (const id of ids) perLoad.set(id, got ? { outcomes: got.outcomes } : { failed: why });
  }
  return perLoad;
}

function plan(recs, lookup) {
  const changes = [];
  const unchanged = [];
  for (const r of recs) {
    const id = String(r.auctionId);
    const src = lookup(id);
    if (src.failed) { unchanged.push({ id, why: src.failed }); continue; }
    if (!src.outcomes.has(id)) { unchanged.push({ id, why: 'not in PENDING (allotted, cancelled or outside the dates)' }); continue; }
    const hit = src.outcomes.get(id);
    if (!hit) { unchanged.push({ id, why: 'in PENDING with no active ranked row of ours' }); continue; }
    changes.push({ rec: r, id, rank: hit.rank, amount: hit.amount, won: hit.rank === 1 });
  }
  return { changes, unchanged };
}

function patchFor(c, at) {
  const r = c.rec;
  const merged = Object.assign({}, r, { finalRank: c.rank, won: c.won });
  const landed = Array.isArray(r.ourBids) ? r.ourBids.filter(Boolean).length : 0;
  const resultReason = c.won ? 'won' : (landed > 0 ? resultReasonOf(merged, { landedBids: landed }) : r.resultReason);
  return {
    __expect: { finalRank: r.finalRank, won: r.won, status: 'closed' },
    finalRank: c.rank, won: c.won, resultReason,
    finalRankBackfill: { source: 'sp_v4_pending', previous: { finalRank: r.finalRank, won: r.won === undefined ? null : r.won },
      amount: c.amount, at },
  };
}

const show = (v) => (v === undefined ? 'null' : JSON.stringify(v));

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const dataDir = o.dataDir || require('../src/config').dataDir;
  const spKey = require('../src/config').platformKey;
  const store = createStore({ dataDir, logDir: path.join(dataDir, 'logs'), backend: 'file' });
  const recs = candidates(await store.listDocs(COLLECTION), Date.parse(`${o.since}T00:00:00Z`), spKey);
  console.log(`${recs.length} SuperProcure record(s) closed since ${o.since} with finalRank null and a bid of ours`);

  let lookup;
  if (o.v4File) {
    const raw = JSON.parse(fs.readFileSync(o.v4File, 'utf8'));
    const outcomes = settledFromV4(raw.data || raw, { carrierIds: o.carriers });
    lookup = () => ({ outcomes });
  } else {
    const perLoad = await liveOutcomes(store, recs, o.since);
    lookup = (id) => perLoad.get(id);
  }

  const { changes, unchanged } = plan(recs, lookup);
  for (const c of changes) {
    console.log(`${c.id}  finalRank ${show(c.rec.finalRank)} -> ${c.rank}  won ${show(c.rec.won)} -> ${c.won}  (SP amount ${c.amount != null ? c.amount : '-'})`);
  }
  for (const u of unchanged) console.log(`${u.id}  unchanged: ${u.why}`);
  console.log(`${changes.length} record(s) would change, ${unchanged.length} unchanged`);

  if (!o.apply) {
    if (changes.length) console.log(`dry-run: nothing written. To write: --apply --expect=${changes.length}`);
    return 0;
  }
  if (o.expect == null || Number(o.expect) !== changes.length) {
    console.log(`REFUSED: planned ${changes.length} change(s), expected ${o.expect == null ? '(none given)' : o.expect}. Nothing written.`);
    return 3;
  }
  const at = Date.now();
  let written = 0;
  const refused = [];
  for (const c of changes) {
    try {
      await store.patchDoc(COLLECTION, c.id, patchFor(c, at));
      written++;
    } catch (e) {
      refused.push(`${c.id}: ${e && e.message}`);
    }
  }
  console.log(`wrote ${written} of ${changes.length}`);
  for (const r of refused) console.log(`  not written - ${r}`);
  return refused.length ? 4 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(`FAILED: ${e && e.stack}`); process.exit(1); });
