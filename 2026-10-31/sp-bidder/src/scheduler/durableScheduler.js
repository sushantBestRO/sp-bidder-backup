'use strict';

const { readJSON, writeJSONAtomic } = require('../store/atomicFile');
const { createLogger } = require('../logging/logger');

// One scheduler instance is constructed per enabled SuperProcure account (server.js), each
// against its own intents file, so a single module-level logger tagged 'scheduler' - rather
// than a per-instance DI param like some other classes in this codebase take - is enough to
// tell every restart/persist event apart in `pm2 logs` by its own log line content (filePath,
// counts) without adding a constructor parameter this class has never needed.
const log = createLogger('scheduler');

/**
 * DurableScheduler — restart-safe store of bid INTENTS.
 *
 * The reference system kept every live auction in in-memory Maps, so a crash or
 * restart silently abandoned every in-flight bid. This is the fix, demonstrated
 * with zero infrastructure: every commitment to bid is written to disk the moment
 * it's made, and a boot-time supervisor re-arms every still-open intent.
 *
 * Production swap: replace the JSON file with BullMQ (Redis-backed delayed jobs)
 * — the architecture is identical (durable store of intent + supervisor that
 * re-asserts on boot + a fine-grained in-memory timer for the final-second fire).
 * Here the persistence is a file; there it's Redis. The engine doesn't care.
 *
 * An intent:
 *   { auctionId, marketRate, costFloor, lane, equipment, closesAt,
 *     status: 'armed'|'bidding'|'closed', firedRungs: [..], finalRank, won,
 *     createdAt, updatedAt }
 */
class DurableScheduler {
  constructor(filePath) {
    this.filePath = filePath;
    this.intents = new Map();
    this._load();
  }

  _load() {
    // readJSON backs up a corrupt file + returns the fallback (a bad file never takes the bot
    // down). Record corruption so rehydrate() can alert instead of silently booting empty.
    this.loadCorrupted = false;
    const raw = readJSON(this.filePath, null, { onCorrupt: () => { this.loadCorrupted = true; } });
    if (raw && Array.isArray(raw.intents)) {
      for (const it of raw.intents) this.intents.set(it.auctionId, it);
    }
    // Boot-time signal: this constructor runs once per account stack at process start, so
    // this is the one place that can report what the intents file actually held before the
    // caller's own boot-time supervisor re-arms against activeIntents(). Log both the raw
    // count recovered from disk and how many of those are still open (not closed/stopped) -
    // the subset eligible to be re-armed - so a restart's outcome is visible in `pm2 logs`
    // instead of only inferable after the fact from whatever bids do or don't fire next.
    const found = this.intents.size;
    const reArmable = this.activeIntents().length;
    log.info(`scheduler rehydrated ${found} intent(s) from disk, ${reArmable} still open and eligible for re-arm`,
      { filePath: this.filePath, found, reArmable });
  }

  /** True if the intents file existed but failed to parse on load (backed up as .corrupt). */
  hadLoadError() { return !!this.loadCorrupted; }

  _persist() {
    try {
      writeJSONAtomic(this.filePath, { savedAt: Date.now(), intents: [...this.intents.values()] });
    } catch (err) {
      // writeJSONAtomic throws synchronously on any fs failure (disk full, permissions, a
      // missing/unwritable data dir), and that exception already propagates out to the caller
      // (upsert/update/remove) unchanged - but nothing here ever said WHY a bid intent failed
      // to reach disk, so a persist failure could go unnoticed until the next restart silently
      // rehydrated a stale intent set. Surface it, then rethrow the same error so callers keep
      // seeing exactly the failure they saw before this line existed.
      log.error(`scheduler failed to persist intents to disk (${this.filePath})`, { err, filePath: this.filePath });
      throw err;
    }
  }

  upsert(intent) {
    const now = Date.now();
    const existing = this.intents.get(intent.auctionId);
    const merged = Object.assign({ createdAt: now }, existing, intent, { updatedAt: now });
    this.intents.set(intent.auctionId, merged);
    this._persist();
    return merged;
  }

  update(auctionId, patch) {
    const existing = this.intents.get(auctionId);
    if (!existing) return null;
    // ROLL BACK ON A FAILED WRITE. The mutation used to stand whatever _persist() did, so a retire
    // whose write threw left the intent 'closed' in memory and still open on disk: activeIntents()
    // dropped it, nothing re-armed it, and nothing had retired it either - a live auction abandoned
    // by a disk error. The throw still propagates unchanged; only the half-applied memory state goes.
    const prior = Object.assign({}, existing);
    Object.assign(existing, patch, { updatedAt: Date.now() });
    try {
      this._persist();
    } catch (err) {
      for (const k of Object.keys(existing)) delete existing[k];
      Object.assign(existing, prior);
      throw err;
    }
    return existing;
  }

  get(auctionId) { return this.intents.get(auctionId); }

  /** Intents that should be live after a restart (not yet closed or operator-stopped). */
  activeIntents() {
    return [...this.intents.values()].filter(i => i.status !== 'closed' && i.status !== 'stopped');
  }

  all() { return [...this.intents.values()]; }

  remove(auctionId) {
    if (this.intents.delete(auctionId)) this._persist();
  }
}

module.exports = { DurableScheduler };
