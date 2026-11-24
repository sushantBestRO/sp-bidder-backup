'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging/logger');

const log = createLogger('atomicFile');

/**
 * atomicFile — the ONE place in the app that touches `fs` for durable state.
 *
 * Lifts the write-tmp -> rename + corrupt-file-backup pattern that was duplicated
 * in scheduler/durableScheduler.js and the since-deleted auth/session.js into a
 * single primitive, so the grep gate "no require('fs') for app state outside
 * src/store/" holds and the file I/O has exactly one implementation. The async
 * store (fileStore.js) and the legacy sync consumer (scheduler) build on these.
 */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Read + parse JSON. Missing file -> `fallback`; CORRUPT file -> back it up + return `fallback`
 *  (a bad file must never take the bot down) and fire `onCorrupt` so callers can alert instead
 *  of silently losing state. The backup itself is also worth a log line: this is the one place
 *  a corruption is discovered, and without it an operator has no way to know a collection or
 *  event stream silently reverted to its fallback value until something downstream looks wrong. */
function readJSON(filePath, fallback = null, { onCorrupt } = {}) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    const backupPath = filePath + '.corrupt.' + Date.now();
    try {
      fs.renameSync(filePath, backupPath);
      log.warn('corrupt file detected, moved to backup', { path: filePath, backupPath });
    } catch (_e) {}
    if (typeof onCorrupt === 'function') { try { onCorrupt(); } catch (_e) {} }
    return fallback;
  }
}

/** Write JSON via tmp + atomic-ish rename, so a crash never leaves a half file. */
function writeJSONAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

/**
 * Non-blocking sibling of writeJSONAtomic: the SAME tmp + rename, the same bytes, but the write runs
 * on libuv's threadpool instead of blocking the event loop. For collections written from the
 * bidding/delivery path, where a whole-file write of a grown collection is tens of ms the bid
 * monitor and the SP socket share a thread with (the rule appendJSONLAsync already follows). The
 * directory is created only on a first-write ENOENT, so no synchronous existsSync is paid per write.
 *
 * The tmp file carries a per-write suffix rather than the sync path's shared `.tmp`: a sync write to
 * the same collection can land between this write and its rename, and a shared name would let it
 * rename away the tmp this call is about to move.
 */
let tmpSeq = 0;
async function writeJSONAtomicAsync(filePath, value) {
  const tmp = `${filePath}.tmp.${process.pid}.${++tmpSeq}`;
  const body = JSON.stringify(value, null, 2);
  try {
    await fs.promises.writeFile(tmp, body);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(tmp, body);
  }
  await fs.promises.rename(tmp, filePath);
}

const signatureOf = (st) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`;

/** Identity of a file's current contents as far as stat can tell: 'missing' when absent. An in-place
 *  edit that keeps the size and lands inside the same filesystem timestamp tick is invisible to it. */
function fileSignature(filePath) {
  const st = fs.statSync(filePath, { bigint: true, throwIfNoEntry: false });
  return st ? signatureOf(st) : 'missing';
}

/**
 * Writes pre-serialized chunks with the same tmp + rename as writeJSONAtomicAsync, via one writev, so
 * the caller never joins or encodes the whole body on the event loop. Resolves with the fileSignature
 * of the renamed file, taken from the tmp before the rename (rename keeps inode, size and mtime), so
 * no edit landing after the rename can be mistaken for this write.
 */
async function writeChunksAtomicAsync(filePath, chunks) {
  const tmp = `${filePath}.tmp.${process.pid}.${++tmpSeq}`;
  let fh;
  try {
    fh = await fs.promises.open(tmp, 'w');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    fh = await fs.promises.open(tmp, 'w');
  }
  let expected = 0;
  for (const c of chunks) expected += c.length;
  try {
    const { bytesWritten } = await fh.writev(chunks);
    if (bytesWritten !== expected) throw new Error(`short write to ${tmp}: ${bytesWritten} of ${expected} bytes`);
  } finally {
    await fh.close();
  }
  const sig = signatureOf(await fs.promises.stat(tmp, { bigint: true }));
  await fs.promises.rename(tmp, filePath);
  return sig;
}

/** Non-blocking sibling of readJSON, with the same contract: missing file -> `fallback`, CORRUPT
 *  file -> back it up + return `fallback` so a bad file never takes the bot down, and fire
 *  `onCorrupt` (same option as the sync readJSON) so callers can alert instead of losing state
 *  silently. */
async function readJSONAsync(filePath, fallback = null, { onCorrupt } = {}) {
  if (!filePath) return fallback;
  let raw;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (_) {
    const backupPath = filePath + '.corrupt.' + Date.now();
    try {
      await fs.promises.rename(filePath, backupPath);
      log.warn('corrupt file detected, moved to backup', { path: filePath, backupPath });
    } catch (_e) {}
    if (typeof onCorrupt === 'function') { try { onCorrupt(); } catch (_e) {} }
    return fallback;
  }
}

/** Append one record as a JSON line (the day-1 logging / event-stream primitive). */
function appendJSONL(filePath, record) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n');
}

/**
 * Non-blocking sibling of appendJSONL: the SAME JSON-line bytes, but the disk write runs on
 * libuv's threadpool via fs.promises rather than blocking the event loop with appendFileSync.
 * For the high-frequency per-tick rank-sample sink (bidLogger.sampleRank) so NO synchronous fs
 * I/O ever lands on the bid-fire path (PR #59 S1). Happy path is a single appendFile with zero
 * blocking syscalls; the directory is created (and the append retried) only on the first-write
 * ENOENT, so we never pay a synchronous existsSync per tick the way ensureDir does.
 */
async function appendJSONLAsync(filePath, record) {
  const line = JSON.stringify(record) + '\n';
  try {
    await fs.promises.appendFile(filePath, line);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.appendFile(filePath, line);
      return;
    }
    throw err;
  }
}

/** Read a file's raw UTF-8 text; missing or unreadable -> null. No parse, no corrupt-backup
 *  dance (unlike readJSON) - for a read-only artifact (e.g. the deploy version.json) where the
 *  caller wants to interpret absent vs present-but-malformed itself and must never mutate the
 *  file. Keeps the sole fs touch inside src/store/, so the grep gate holds. */
function readTextFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try { return fs.readFileSync(filePath, 'utf8'); } catch (_) { return null; }
}

/** Read a JSONL file into an array; missing file -> []; skip unparseable lines. */
function readJSONL(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const out = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) {}
  }
  return out;
}

/**
 * Every day `stream` actually has a file for, as UTC-midnight epoch ms, sorted ascending. ONE
 * async directory listing - never a per-day existence probe. A caller that wants records from a
 * stream's whole history (readEvents' day-loop otherwise starts at whatever `from` it is given,
 * including epoch 0 - 20,000+ synchronous existsSync/readFileSync calls for a stream that has
 * only ever had a few weeks of files) uses this to bound `from`/`to` to real files first.
 * [] when the log dir does not exist yet or the stream has never been written.
 */
async function listStreamDays(logDir, stream) {
  let names;
  try { names = await fs.promises.readdir(logDir); } catch (_) { return []; }
  const esc = stream.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`);
  const days = [];
  for (const name of names) {
    const m = re.exec(name);
    if (m) days.push(Date.parse(`${m[1]}T00:00:00.000Z`));
  }
  return days.sort((a, b) => a - b);
}

module.exports = {
  ensureDir, readJSON, readJSONAsync, readTextFile, writeJSONAtomic, writeJSONAtomicAsync,
  fileSignature, writeChunksAtomicAsync, appendJSONL, appendJSONLAsync, readJSONL, listStreamDays,
};
