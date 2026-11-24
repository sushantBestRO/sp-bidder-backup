'use strict';

const { FileStore } = require('./fileStore');
const { MemoryStore } = require('./memoryStore');

/**
 * The store seam (Seam 1). All durable application state goes through one of these
 * — file-backed by default, swappable to a managed store later (migration trigger
 * #1) with no call-site changes because the interface is async and backend-agnostic.
 *
 * Interface (both backends):
 *   getDoc / putDoc / patchDoc / listDocs / removeDoc  — keyed documents
 *   getDocAsync / putDocAsync / listDocsAsync / removeDocAsync - the non-blocking variants, for
 *     state written from the bidding/delivery path; same results, same bytes, no blocking write
 *   appendEvent / appendEventAsync / readEvents         — append-only event streams
 *     (appendEventAsync = the non-blocking variant for high-frequency sinks; same bytes)
 *
 * Pick the backend via opts.backend or STORE_BACKEND ('file' default | 'memory').
 */
function createStore(opts = {}) {
  const backend = (opts.backend || process.env.STORE_BACKEND || 'file').toLowerCase();
  if (backend === 'memory') return new MemoryStore();
  return new FileStore(opts);
}

module.exports = { createStore, FileStore, MemoryStore };
