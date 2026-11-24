'use strict';

const path = require('path');
const {
  readJSON, readJSONAsync, writeJSONAtomic, writeJSONAtomicAsync,
  fileSignature, writeChunksAtomicAsync,
  appendJSONL, appendJSONLAsync, readJSONL, listStreamDays,
} = require('./atomicFile');
const { createLogger } = require('../logging/logger');
const { splitExpect, assertExpected } = require('./expect');

const log = createLogger('fileStore');

// closedBids is written on every engine event, from the thread that runs the bid timers, and it
// only grows. These collections are held as one pre-serialized entry per document so a write costs
// the changed document, not the collection; the file is still revalidated on every call.
const HELD = new Set(['closedBids']);

// priceRequests is megabytes and read on every discovery step and every open price page's poll. It is
// parsed once per file version and held as one JSON string per document, so a read parses only the
// documents it returns and every caller gets its own copy to mutate.
const PARSE_CACHED = new Set(['priceRequests']);

const OPEN = Buffer.from('{\n');
const SEP = Buffer.from(',\n');
const CLOSE = Buffer.from('\n}');
const EMPTY = Buffer.from('{}');

// One document exactly as JSON.stringify(map, null, 2) lays it out; null when that would omit it.
function entryBytes(key, value) {
  const body = JSON.stringify(value, null, 2);
  if (body === undefined) return null;
  const text = `  ${JSON.stringify(key)}: ${body.replace(/\n/g, '\n  ')}`;
  // Unpooled: a pooled slice would pin its whole 8 KB slab for as long as the entry is held.
  const buf = Buffer.allocUnsafeSlow(Buffer.byteLength(text));
  buf.write(text);
  return buf;
}

function entryValue(entries, key) {
  const e = entries[key];
  return e ? JSON.parse('{' + e.toString('utf8') + '}')[key] : null;
}

/**
 * FileStore — the default (and only shipping) store backend for Module 1.
 *
 * The interface is ASYNC on purpose: every method returns a Promise even though
 * the file backend is synchronous underneath, so a network-backed store later
 * (Postgres/Firestore — Seam 1 / migration trigger #1) is a drop-in with zero
 * call-site changes. There is NO database here; that is the point — the file store
 * IS the product for Module 1, the interface is the hedge.
 *
 * Two data shapes:
 *  - Keyed documents (operational config: accounts, targets, recipients, floors,
 *    users, session state) -> one JSON file per collection holding { [id]: value }.
 *  - Append-only event streams (the day-1 bid/rank/extension log — the future
 *    auto-floor training signal that cannot be backfilled) -> append-daily JSONL
 *    at <logDir>/<stream>-YYYY-MM-DD.jsonl.
 */
class FileStore {
  constructor({ dataDir, logDir } = {}) {
    this.dataDir = dataDir || '.';
    this.logDir = logDir || path.join(this.dataDir, 'logs');
    this._chains = new Map();   // collection -> the promise every async doc op on it queues behind
    this._held = new Map();     // HELD collection -> { sig, entries } as of this store's last read or write
    this._corrupt = new Set();  // collections whose file was found corrupt (and moved aside) since last asked
    // Fired with the collection name whenever atomicFile finds a corrupt collection file (it has
    // already backed it up and returned the {} fallback by the time this runs). Settable rather than
    // a constructor param because the notifier this feeds doesn't exist yet when the store is built.
    // Left null, every collection falls back to {} exactly as before, with only atomicFile's own
    // warn line - no caller is required to wire this.
    this.onCorrupt = null;
    this._parsed = new Map();   // PARSE_CACHED collection -> { sig, docs } as of this store's last read
  }

  // ---- keyed documents ----
  _collPath(collection) { return path.join(this.dataDir, collection + '.json'); }
  _coll(collection) {
    const onCorrupt = () => this._reportCorrupt(collection);
    if (!PARSE_CACHED.has(collection)) return readJSON(this._collPath(collection), {}, { onCorrupt }) || {};
    const docs = this._parsedDocs(collection);
    const m = {};
    for (const k of Object.keys(docs)) m[k] = JSON.parse(docs[k]);
    return m;
  }
  /** True once after a read found `collection`'s file corrupt, so a caller can say so accurately. */
  takeCorrupt(collection) { return this._corrupt.delete(collection); }
  _reportCorrupt(collection) {
    this._corrupt.add(collection);
    if (typeof this.onCorrupt === 'function') { try { this.onCorrupt(collection); } catch (_) {} }
  }
  // The signature is taken before the read, so a file replaced mid-read is re-read next time.
  _parsedDocs(collection) {
    const file = this._collPath(collection);
    const sig = fileSignature(file);
    const held = this._parsed.get(collection);
    if (held && held.sig === sig) return held.docs;
    const map = readJSON(file, {}, { onCorrupt: () => this._reportCorrupt(collection) }) || {};
    const docs = Object.create(null);
    for (const k of Object.keys(map)) docs[k] = JSON.stringify(map[k]);
    this._parsed.set(collection, { sig, docs });
    return docs;
  }
  // Every keyed-document write funnels through here, and several call sites elsewhere in
  // the app (account reconnect, config audit, etc.) await a store write with a bare
  // `.catch(() => {})` so a disk-full or permissions failure never blocks the request -
  // which also means, without a log line at the seam itself, that failure leaves no trace
  // anywhere. Log at error before rethrowing so the failure is visible in pm2 logs even
  // when the caller swallows the rejection; the throw keeps this seam's contract unchanged.
  _saveColl(collection, map) {
    try {
      writeJSONAtomic(this._collPath(collection), map);
    } catch (err) {
      log.error('write failed', { collection, err });
      throw err;
    } finally {
      this._parsed.delete(collection);
    }
  }

  async getDoc(collection, id) {
    if (HELD.has(collection)) return this._queue(collection, () => entryValue(this._heldEntries(collection), String(id)));
    if (PARSE_CACHED.has(collection)) {
      const docs = this._parsedDocs(collection);
      const k = String(id);
      return Object.prototype.hasOwnProperty.call(docs, k) ? JSON.parse(docs[k]) : null;
    }
    const m = this._coll(collection);
    const k = String(id);
    return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null;
  }
  async putDoc(collection, id, value) {
    if (HELD.has(collection)) {
      return this._queue(collection, async () => {
        const entries = this._heldEntries(collection);
        this._setEntry(entries, String(id), value);
        await this._saveHeld(collection, entries);
        return value;
      });
    }
    const m = this._coll(collection);
    m[String(id)] = value;
    this._saveColl(collection, m);
    return value;
  }
  async patchDoc(collection, id, partial) {
    const { patch, expect } = splitExpect(partial);
    if (HELD.has(collection)) {
      return this._queue(collection, async () => {
        const entries = this._heldEntries(collection);
        const k = String(id);
        assertExpected(entryValue(entries, k), expect);
        const merged = Object.assign({}, entryValue(entries, k) || {}, patch);
        this._setEntry(entries, k, merged);
        await this._saveHeld(collection, entries);
        return merged;
      });
    }
    const m = this._coll(collection);
    const k = String(id);
    assertExpected(m[k], expect);
    const merged = Object.assign({}, m[k] || {}, patch);
    m[k] = merged;
    this._saveColl(collection, m);
    return merged;
  }
  async listDocs(collection) {
    if (HELD.has(collection)) {
      return this._queue(collection, () => {
        const entries = this._heldEntries(collection);
        return Object.keys(entries).map((k) => entryValue(entries, k));
      });
    }
    if (PARSE_CACHED.has(collection)) {
      const docs = this._parsedDocs(collection);
      return Object.keys(docs).map((k) => JSON.parse(docs[k]));
    }
    return Object.values(this._coll(collection));
  }
  async removeDoc(collection, id) {
    if (HELD.has(collection)) {
      return this._queue(collection, async () => {
        const entries = this._heldEntries(collection);
        const k = String(id);
        if (!entries[k]) return false;
        delete entries[k];
        await this._saveHeld(collection, entries);
        return true;
      });
    }
    const m = this._coll(collection);
    const k = String(id);
    if (!Object.prototype.hasOwnProperty.call(m, k)) return false;
    delete m[k];
    this._saveColl(collection, m);
    return true;
  }

  // ---- HELD collections ----
  //
  // Only ever called inside _queue, so no two of these interleave on one collection. A file whose
  // stat no longer matches the last read or write here (a hand edit, another process) is re-read and
  // re-parsed whole, synchronously - the one place a HELD collection still costs its full size.
  _heldEntries(collection) {
    const file = this._collPath(collection);
    const sig = fileSignature(file);
    const held = this._held.get(collection);
    if (held && held.sig === sig) return held.entries;
    const map = readJSON(file, {}, { onCorrupt: () => this._reportCorrupt(collection) }) || {};
    const entries = Object.create(null);
    for (const k of Object.keys(map)) {
      const e = entryBytes(k, map[k]);
      if (e) entries[k] = e;
    }
    this._held.set(collection, { sig, entries });
    return entries;
  }
  _setEntry(entries, k, value) {
    const e = entryBytes(k, value);
    if (e) entries[k] = e;
    else delete entries[k];
  }
  // The entries were already changed in place, so on a failed write they no longer match the disk:
  // drop them and let the next call re-read the file. Same log-then-rethrow contract as _saveColl.
  async _saveHeld(collection, entries) {
    const keys = Object.keys(entries);
    const chunks = [];
    if (!keys.length) chunks.push(EMPTY);
    else {
      chunks.push(OPEN);
      for (let i = 0; i < keys.length; i++) {
        if (i) chunks.push(SEP);
        chunks.push(entries[keys[i]]);
      }
      chunks.push(CLOSE);
    }
    try {
      const sig = await writeChunksAtomicAsync(this._collPath(collection), chunks);
      this._held.set(collection, { sig, entries });
    } catch (err) {
      this._held.delete(collection);
      log.error('write failed', { collection, err });
      throw err;
    }
  }

  // ---- keyed documents, non-blocking ----
  //
  // Same observable results as the four above and the same bytes on disk, but the fs work runs on
  // libuv's threadpool instead of blocking the event loop - the rule appendEventAsync already
  // follows for the per-tick rank sink (PR #59 S1). For collections written from the bidding or
  // delivery path: a whole-file read-modify-write of a grown collection costs tens of ms on the same
  // process as the bid monitor and the SP socket, and that is not a cost an anchor write may impose
  // on a live auction.
  //
  // Every async op queues on its collection. The sync path gets read-modify-write atomicity free -
  // one tick, no suspension point - and the async path would lose it: two writes to the same
  // collection would both read the pre-write map and the second would drop the first's document.
  _queue(collection, fn) {
    const prev = this._chains.get(collection) || Promise.resolve();
    const run = prev.then(fn, fn);
    this._chains.set(collection, run.then(() => {}, () => {}));
    return run;
  }
  async _collAsync(collection) {
    return (await readJSONAsync(this._collPath(collection), {}, { onCorrupt: () => this._reportCorrupt(collection) })) || {};
  }
  // Same failure-surfacing contract as _saveColl: log at the seam so a caller's swallowed rejection
  // still shows in pm2 logs, then rethrow.
  async _saveCollAsync(collection, map) {
    this._parsed.delete(collection);
    try {
      await writeJSONAtomicAsync(this._collPath(collection), map);
    } catch (err) {
      log.error('write failed', { collection, err });
      throw err;
    } finally {
      this._parsed.delete(collection);
    }
  }

  async getDocAsync(collection, id) {
    if (HELD.has(collection)) return this.getDoc(collection, id);
    return this._queue(collection, async () => {
      const m = await this._collAsync(collection);
      const k = String(id);
      return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null;
    });
  }
  async putDocAsync(collection, id, value) {
    if (HELD.has(collection)) return this.putDoc(collection, id, value);
    return this._queue(collection, async () => {
      const m = await this._collAsync(collection);
      m[String(id)] = value;
      await this._saveCollAsync(collection, m);
      return value;
    });
  }
  async listDocsAsync(collection) {
    if (HELD.has(collection)) return this.listDocs(collection);
    return this._queue(collection, async () => Object.values(await this._collAsync(collection)));
  }
  async removeDocAsync(collection, id) {
    if (HELD.has(collection)) return this.removeDoc(collection, id);
    return this._queue(collection, async () => {
      const m = await this._collAsync(collection);
      const k = String(id);
      if (!Object.prototype.hasOwnProperty.call(m, k)) return false;
      delete m[k];
      await this._saveCollAsync(collection, m);
      return true;
    });
  }

  /** The collection file's signature (device, inode, size, mtime): a changed value means changed content. */
  signature(collection) { return fileSignature(this._collPath(collection)); }

  // ---- append-only event streams ----
  _streamPath(stream, dateMs) {
    const day = new Date(dateMs).toISOString().slice(0, 10);
    return path.join(this.logDir, `${stream}-${day}.jsonl`);
  }
  async appendEvent(stream, record) {
    const rec = Object.assign({ ts: Date.now() }, record);
    // Same rationale as _saveColl: callers of appendEvent (bid/rank/extension logging,
    // config-change audit) routinely fire-and-forget this call, so the append itself is
    // the only place a disk failure can still be surfaced.
    try {
      appendJSONL(this._streamPath(stream, rec.ts), rec);
    } catch (err) {
      log.error('append failed', { stream, err });
      throw err;
    }
    return rec;
  }
  // Non-blocking append: byte-identical to appendEvent (same ts stamp, same JSON line) but the
  // disk write runs on libuv's threadpool instead of blocking the event loop with appendFileSync.
  // For the per-tick rank-sample sink, which fires on the bid-monitor tick and must never put a
  // synchronous fs write on the snipe path (PR #59 S1). Same failure-surfacing contract as the
  // sync sibling: log at the seam so a swallowed rejection still shows in pm2 logs, then rethrow.
  async appendEventAsync(stream, record) {
    const rec = Object.assign({ ts: Date.now() }, record);
    try {
      await appendJSONLAsync(this._streamPath(stream, rec.ts), rec);
    } catch (err) {
      log.error('append failed', { stream, err });
      throw err;
    }
    return rec;
  }
  async readEvents(stream, { from, to } = {}) {
    const toMs = to != null ? Number(to) : Date.now();
    const fromMs = from != null ? Number(from) : toMs;
    // enumerate the day files spanning [fromMs, toMs]; default (no range) = today.
    const days = [];
    if (from == null && to == null) {
      days.push(Date.now());
    } else {
      let d = Date.parse(new Date(fromMs).toISOString().slice(0, 10) + 'T00:00:00.000Z');
      while (d <= toMs) { days.push(d); d += 86_400_000; }
    }
    const out = [];
    for (const d of days) {
      for (const rec of readJSONL(this._streamPath(stream, d))) {
        const t = rec.ts != null ? Number(rec.ts) : null;
        if (from != null && t != null && t < fromMs) continue;
        if (to != null && t != null && t > toMs) continue;
        out.push(rec);
      }
    }
    return out;
  }

  /** Every day `stream` actually has a file for, epoch ms sorted ascending - ONE async directory
   *  listing (see atomicFile.listStreamDays). Lets a caller bound readEvents' day-loop to real
   *  files instead of scanning from an arbitrary `from`, including epoch 0. */
  async listStreamDays(stream) { return listStreamDays(this.logDir, stream); }
}

module.exports = { FileStore };
