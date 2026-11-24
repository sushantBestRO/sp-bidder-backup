'use strict';

const { splitExpect, assertExpected } = require('./expect');

/**
 * MemoryStore — the in-memory implementation of the same store interface as
 * FileStore. Used by the store contract test (proving the seam is real, not leaky)
 * and available for tests that want zero disk I/O. Not a shipping backend.
 */
class MemoryStore {
  constructor() {
    this.docs = new Map();    // collection -> Map(id -> value)
    this.streams = new Map(); // stream -> [record]
  }

  _coll(collection) {
    if (!this.docs.has(collection)) this.docs.set(collection, new Map());
    return this.docs.get(collection);
  }

  async getDoc(collection, id) {
    const m = this._coll(collection);
    return m.has(String(id)) ? m.get(String(id)) : null;
  }
  async putDoc(collection, id, value) { this._coll(collection).set(String(id), value); return value; }
  async patchDoc(collection, id, partial) {
    const m = this._coll(collection);
    const { patch, expect } = splitExpect(partial);
    assertExpected(m.get(String(id)), expect);
    const merged = Object.assign({}, m.get(String(id)) || {}, patch);
    m.set(String(id), merged);
    return merged;
  }
  async listDocs(collection) { return [...this._coll(collection).values()]; }
  async removeDoc(collection, id) { return this._coll(collection).delete(String(id)); }

  // Seam parity with FileStore's non-blocking document methods. There is no disk here, so the async
  // four are the sync four; kept so a store consumer can call either uniformly.
  async getDocAsync(collection, id) { return this.getDoc(collection, id); }
  async putDocAsync(collection, id, value) { return this.putDoc(collection, id, value); }
  async listDocsAsync(collection) { return this.listDocs(collection); }
  async removeDocAsync(collection, id) { return this.removeDoc(collection, id); }

  _stream(stream) {
    if (!this.streams.has(stream)) this.streams.set(stream, []);
    return this.streams.get(stream);
  }
  async appendEvent(stream, record) {
    const rec = Object.assign({ ts: Date.now() }, record);
    this._stream(stream).push(rec);
    return rec;
  }
  // Seam parity with FileStore.appendEventAsync (the non-blocking append). There is no disk here,
  // so sync vs async is the same push; kept so a store consumer can call either method uniformly.
  async appendEventAsync(stream, record) { return this.appendEvent(stream, record); }
  async readEvents(stream, { from, to } = {}) {
    return this._stream(stream).filter((r) => {
      const t = r.ts != null ? Number(r.ts) : null;
      if (from != null && t != null && t < Number(from)) return false;
      if (to != null && t != null && t > Number(to)) return false;
      return true;
    });
  }

  // Interface parity with FileStore.listStreamDays - there is no per-day file cost here (everything
  // is already in one array), so this is just the distinct day-starts already held, for a caller
  // that wants to bound a readEvents call the same way regardless of backend.
  async listStreamDays(stream) {
    const days = new Set();
    for (const r of this._stream(stream)) {
      const t = r.ts != null ? Number(r.ts) : null;
      if (t != null) days.add(new Date(t).toISOString().slice(0, 10));
    }
    return [...days].map((d) => Date.parse(`${d}T00:00:00.000Z`)).sort((a, b) => a - b);
  }
}

module.exports = { MemoryStore };
