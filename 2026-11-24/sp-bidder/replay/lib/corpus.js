'use strict';
/**
 * Corpus loaders — read-only, deterministic, and explicit about what is missing.
 *
 * IMPORTANT: the corpora live in the SUPER-repo (clients/brl/automated-bidding/...), NOT in this
 * git repo, and they are gitignored there. CI therefore has no corpus. Every loader here reports
 * `available: false` rather than throwing, so `npm test` stays green on a machine without the data
 * while still running the full synthetic-fixture suite. A replay RUN against a missing corpus is a
 * hard error; a replay TEST against a missing corpus degrades to fixtures and says so.
 *
 * Two GoComet corpora exist and they are NOT the same bot. See replay/README.md for the evidence.
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DATA_ROOT = path.resolve(REPO_ROOT, '..', '..', 'automated-bidding');

function dataRoot() {
  return process.env.REPLAY_CORPUS_ROOT
    ? path.resolve(process.env.REPLAY_CORPUS_ROOT)
    : DEFAULT_DATA_ROOT;
}

const CORPORA = {
  'gocomet-dead': () => path.join(dataRoot(), '_research', 'data', 'gocomet-bids', 'dead'),
  'gocomet-live': () => path.join(dataRoot(), '_research', 'data', 'gocomet-bids', 'live'),
  'gocomet-reference': () => path.join(dataRoot(), 'reference', 'brl-gocomet', 'raw', 'old_ver', 'logs', 'bids'),
  'gocomet-source': () => path.join(dataRoot(), 'reference', 'brl-gocomet', 'source', 'logs', 'bids'),
};

const SP_CAPTURE_ACCOUNTS = ['ludhiana', 'master', 'neemrana', 'primary', 'sameer-ambdaskar'];

// BRL's own account, the only company that may legitimately appear in a SuperProcure bidDetails row
// (SP masks external competitor amounts). A row whose companyName does not match this is a foreign
// row: it is COUNTED and its company is surfaced, but it is never retained — so no external amount
// or bidder PII (userMobile/userName) ever enters the harness's own-bids set.
const OWN_COMPANY_MATCH = /best\s*roadways/i;
function isOwnCompany(name) { return typeof name === 'string' && OWN_COMPANY_MATCH.test(name); }

function corpusPath(name) {
  const f = CORPORA[name];
  if (!f) throw new Error(`unknown corpus '${name}' (known: ${Object.keys(CORPORA).sort().join(', ')})`);
  return f();
}

function corpusAvailable(name) {
  try { return fs.statSync(corpusPath(name)).isDirectory(); } catch (_) { return false; }
}

/**
 * Load one GoComet bid-log corpus.
 *
 * Returns { available, dir, files, records, parseFailures, recordsLost }.
 * Files are read in sorted order and records keep their in-file order, so the result is
 * byte-stable across runs and across filesystems with different natural ordering.
 *
 * A malformed file is REPORTED, never repaired and never silently dropped. live/bids_2026-01-09.json
 * is known-malformed (a missing comma between two array elements, i.e. an interrupted append by
 * BRL's own bot). Repairing it would mean inventing record boundaries, so the loader counts the
 * loss instead and every downstream report carries the number.
 */
function loadGocometCorpus(name) {
  const dir = corpusPath(name);
  if (!corpusAvailable(name)) {
    return { available: false, name, dir, files: [], records: [], parseFailures: [], recordsLost: null };
  }
  const files = fs.readdirSync(dir).filter((f) => /^bids_\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const records = [];
  const parseFailures = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let raw;
    try { raw = fs.readFileSync(full, 'utf8'); } catch (e) {
      parseFailures.push({ file: f, reason: `read_failed: ${e.message}` });
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      // Count how many records the file APPEARS to hold, so the loss is quantified rather
      // than hand-waved. This counts top-level object openings at the array's indent level.
      const approx = (raw.match(/^\s{2}\{/gm) || []).length;
      parseFailures.push({ file: f, reason: `json_parse_failed: ${e.message}`, approxRecordsLost: approx });
      continue;
    }
    if (!Array.isArray(parsed)) {
      parseFailures.push({ file: f, reason: 'not_an_array' });
      continue;
    }
    for (let i = 0; i < parsed.length; i++) {
      records.push(normaliseGocometRecord(parsed[i], f, i));
    }
  }
  const recordsLost = parseFailures.reduce((n, p) => n + (p.approxRecordsLost || 0), 0);
  return { available: true, name, dir, files, records, parseFailures, recordsLost };
}

/**
 * Normalise one raw bid-log record into a stable internal shape.
 *
 * The raw logs are field-inconsistent in ways that will silently poison arithmetic if not
 * handled at the boundary (all measured across both corpora, 36,365 records):
 *   - bidPrice is int (94%), STRING (5%), float, or absent entirely (1.3%)
 *   - timeToClosingMs is int, float (half-millisecond values are real), or null (24.9% —
 *     these are PUBLIC_SUBMISSION rows, which are catalogue entries, not timed bids)
 *   - currentRank is int or null; revisionsLeft is int or null (present on only ~50% of rows)
 * Anything not confidently numeric becomes null; nothing is guessed.
 */
function normaliseGocometRecord(r, file, index) {
  const num = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v.trim());
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  const tsMs = Date.parse(r.timestamp);
  return {
    file,
    index,
    enquiryKey: typeof r.enquiryKey === 'string' ? r.enquiryKey : null,
    tsMs: Number.isFinite(tsMs) ? tsMs : null,
    tsIso: typeof r.timestamp === 'string' ? r.timestamp : null,
    bidType: typeof r.bidType === 'string' ? r.bidType : null,
    bidPrice: num(r.bidPrice),
    timeToClosingMs: num(r.timeToClosingMs),
    currentRank: num(r.currentRank),
    revisionsLeft: num(r.revisionsLeft),
    bidsSubmitted: num(r.bidsSubmitted),
    success: r.success === true,
    responseTimeMs: num(r.responseTimeMs),
    startedBy: typeof r.startedBy === 'string' ? r.startedBy : null,
    // BRL's OWN pricing model output, present on PUBLIC_SUBMISSION rows only. This is the one
    // legitimate price context in the corpus: marketValue is BRL's own market rate for the lane
    // and high/medium/low are its own marked-up rungs. It is not, and cannot be, a rival's price.
    marketValue: r.calculatedBids ? num(r.calculatedBids.marketValue) : null,
    calculatedBids: r.calculatedBids && typeof r.calculatedBids === 'object' ? {
      high: num(r.calculatedBids.high),
      medium: num(r.calculatedBids.medium),
      low: num(r.calculatedBids.low),
      marketValue: num(r.calculatedBids.marketValue),
    } : null,
  };
}

/**
 * Load the 2026-07-13 SuperProcure OPEN-tab capture (5 accounts).
 *
 * This is the only true per-branch SP capture on disk. Loads are keyed by SP load id and
 * de-duplicated across accounts (master and neemrana overlap), so the same load appearing in
 * two account payloads is counted once.
 */
function loadSpCapture() {
  const dir = path.join(dataRoot(), '_research', 'data');
  const prefix = '2026-07-13_sp-open-loads-';
  const loads = new Map();
  const ownBids = [];
  let foreignBidCount = 0;
  const foreignCompanies = new Set();
  const accounts = [];
  let anyFile = false;
  for (const acct of SP_CAPTURE_ACCOUNTS) {
    const full = path.join(dir, `${prefix}${acct}.json`);
    if (!fs.existsSync(full)) { accounts.push({ account: acct, present: false, loads: 0 }); continue; }
    anyFile = true;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) {
      accounts.push({ account: acct, present: true, error: e.message, loads: 0 });
      continue;
    }
    const ld = Array.isArray(parsed.loadDetails) ? parsed.loadDetails : [];
    for (const L of ld) if (L && L.id != null && !loads.has(L.id)) loads.set(L.id, L);
    // Partition bidDetails at the boundary. Own rows are kept; a foreign row (which would carry an
    // external competitor amount SP is not supposed to expose) is counted and its company recorded,
    // but the row itself — amount, bidRate, userMobile, userName and all — is dropped, never stored.
    for (const b of (Array.isArray(parsed.bidDetails) ? parsed.bidDetails : [])) {
      if (b && isOwnCompany(b.companyName)) ownBids.push(b);
      else { foreignBidCount += 1; foreignCompanies.add(b && b.companyName != null ? String(b.companyName) : '(unknown)'); }
    }
    accounts.push({ account: acct, present: true, loads: ld.length });
  }
  const sorted = [...loads.values()].sort((a, b) => a.id - b.id);
  return {
    available: anyFile, dir, accounts, loads: sorted, ownBids,
    foreignBidCount, foreignCompanies: [...foreignCompanies].sort(),
  };
}

module.exports = {
  CORPORA,
  SP_CAPTURE_ACCOUNTS,
  dataRoot,
  corpusPath,
  corpusAvailable,
  loadGocometCorpus,
  loadSpCapture,
  normaliseGocometRecord,
};
