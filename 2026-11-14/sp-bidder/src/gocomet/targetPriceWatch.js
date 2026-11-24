'use strict';

const { readJSON, writeJSONAtomic } = require('../store/atomicFile');
const { readTargetPrice, isActionableTarget } = require('../platform/gocometTargetPrice');

/**
 * Watches recently-closed GoComet loads for a shipper Target Rate, and holds the separate deadline
 * that comes with one.
 *
 * WHY THIS IS NOT THE DURABLE SCHEDULER. That store is keyed by auctionId and upserts by merging,
 * so a target-price obligation on a load that already has an auction intent would overwrite it, and
 * a second negotiation round would overwrite the first (both observed loads carry
 * number_of_power_negotiations >= 2). Its timers also live in bidEngine and are driven entirely by
 * the auction countdown, which on a closed enquiry reads zero - a re-armed monitor would poll for
 * ~5 minutes against a clock saying "over", place nothing, and raise a never_bid_before_close error
 * at the desk. So this owns its own records, its own file and its own clock.
 *
 * WHY IT DOES NOT BID. A target rate is a margin decision on money already booked, so every record
 * here terminates in a question to the desk, never in an automatic write. The floor belt still
 * exists underneath (the desk's number goes through the same guards any cost does), but the first
 * gate is a human.
 */

const ROUND_SEP = '#';
const DEFAULT_WATCH_MS = 4 * 60 * 60 * 1000;   // how long after close a load stays watched
const DEFAULT_POLL_MS = 60 * 1000;             // how often a watched load is re-read
// Ceiling on reads issued per cycle. At the 60s default this is 5/min = 300/hr, roughly 40% of the
// ROUTINE class - enough headroom that discovery keeps making progress. See dueForPoll.
const DEFAULT_MAX_POLLS_PER_CYCLE = 5;
// How long a settled target record is kept before it is dropped. Long enough that a restart can
// still say what a missed window would have been worth, short enough that the file cannot grow
// without bound on the client's box.
const SETTLED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

class TargetPriceWatch {
  constructor({ filePath, adapter, now = () => Date.now(), log, onTarget, onExpired, watchMs, pollMs, maxPollsPerCycle } = {}) {
    this.filePath = filePath;
    this.adapter = adapter;
    this.now = now;
    this.log = log || { info() {}, warn() {}, error() {}, debug() {} };
    this.onTarget = onTarget || (async () => {});
    this.onExpired = onExpired || (async () => {});
    this.watchMs = Number.isFinite(watchMs) ? watchMs : DEFAULT_WATCH_MS;
    this.pollMs = Number.isFinite(pollMs) ? pollMs : DEFAULT_POLL_MS;
    this.maxPollsPerCycle = Number.isFinite(maxPollsPerCycle) && maxPollsPerCycle > 0
      ? maxPollsPerCycle : DEFAULT_MAX_POLLS_PER_CYCLE;
    this.records = new Map();
    this.corrupt = false;
    this._load();
  }

  _load() {
    // A missing file and a corrupt one both return the fallback, so corruption is detected via the
    // callback, never by testing the return - a first boot would otherwise alarm every time.
    const doc = readJSON(this.filePath, { records: [] }, { onCorrupt: () => { this.corrupt = true; } });
    for (const r of (doc && Array.isArray(doc.records)) ? doc.records : []) {
      if (r && r.id) this.records.set(r.id, r);
    }
  }

  _persist() {
    writeJSONAtomic(this.filePath, { savedAt: this.now(), records: [...this.records.values()] });
  }

  static recordId(enquiryKey, round) { return `${enquiryKey}${ROUND_SEP}${round}`; }

  /**
   * Put a load under watch once its auction has closed. Both captured instances show the target
   * arriving AFTER the close (46 min and 18 min after), on a load the engine had already finalized,
   * so this is deliberately the post-close hook rather than anything on the live path.
   *
   * Not restricted to loads we won: 260817Q9LG was rank 2 at close, still received a target of
   * Rs 1,90,000, and settled Lost when nobody answered. A won-only watch set misses exactly the
   * case that costs money.
   */
  watch(load, { closedAt } = {}) {
    if (!load || !load.id) return null;
    const id = TargetPriceWatch.recordId(load.id, 'watch');
    if (this.records.has(id)) return this.records.get(id);
    const rec = {
      id, kind: 'watch', enquiryKey: String(load.id),
      // THE WHOLE LOAD, not a projection of it. This snapshot is what the desk is eventually shown
      // and what the ask is routed by, and a seven-field copy dropped three things that matter:
      // branchName (so a branch-scoped group asks the wrong desk), rules.minDecrement (so the engine
      // falls back to the platform default instead of the enquiry's own), and the close-model pair
      // softClose/closeModelKnown - whose absence reads as "in scope" to isOutOfHardCloseScope and
      // so fails OPEN on exactly the tri-state the adapter keeps a boolean pair to prevent.
      loadSnapshot: Object.assign({}, load),
      // Measured from the CLOSE, not from enrolment. Enrolment admits a load up to watchMs after its
      // close, so `now + watchMs` could watch one until close + 2*watchMs - roughly doubling the
      // concurrent set on a busy day, against a read budget sized on the 4h figure.
      watchUntil: (Number.isFinite(closedAt) ? closedAt : this.now()) + this.watchMs,
      lastPolledAt: null,
      createdAt: this.now(),
    };
    this.records.set(id, rec);
    this._persist();
    return rec;
  }

  watched() { return [...this.records.values()].filter((r) => r.kind === 'watch'); }
  pending() { return [...this.records.values()].filter((r) => r.kind === 'target' && r.status === 'open'); }

  /**
   * Loads due a re-read this cycle: still inside the watch window, past the poll spacing, and
   * within the per-cycle budget.
   *
   * THE CAP IS A SAFETY PROPERTY, not tidiness. Target reads are ROUTINE, the same class as
   * discovery's listing, so they compete for the slot the read scheduler reserves for that class (a
   * due ROUTINE waiter is served ahead of HOT/POLL); an unbounded watch set would crowd discovery
   * out of it and, past a certain size, stop it finding new loads at all. Arithmetic on
   * the defaults: the ROUTINE class issues 720 reads/hr, and 13 watched loads at a 60s poll wants
   * 780/hr, i.e. more than the whole class. Without this bound a busy day would silently trade
   * away discovery to watch for an event that arrives a couple of times a week.
   *
   * Oldest-close-first, so the loads nearest the end of their watch window - the ones about to
   * stop being checked at all - are the ones that keep getting checked. A load that misses a cycle
   * loses one poll interval, not its whole window.
   */
  dueForPoll(nowMs = this.now()) {
    const due = this.watched().filter((r) => nowMs < r.watchUntil
      && (r.lastPolledAt == null || nowMs - r.lastPolledAt >= this.pollMs));
    if (due.length <= this.maxPollsPerCycle) return due;
    return due
      .sort((a, b) => (a.lastPolledAt || 0) - (b.lastPolledAt || 0))
      .slice(0, this.maxPollsPerCycle);
  }

  /**
   * One cycle. Re-reads each due load, raises a desk ask on a newly-seen target, and retires
   * anything whose window has passed. Never throws: a hydration failure on one load must not stop
   * the others, and must not stop the expiry sweep - a missed expiry is a silent lost load.
   */
  async tick(nowMs = this.now()) {
    const out = { polled: 0, found: 0, expired: 0, errors: 0 };
    for (const rec of this.dueForPoll(nowMs)) {
      out.polled += 1;
      rec.lastPolledAt = nowMs;
      try {
        const facts = await this._hydrate(rec.enquiryKey, nowMs);
        if (facts && isActionableTarget(facts, nowMs)) {
          if (await this._raise(rec, facts, nowMs)) out.found += 1;
        }
      } catch (e) {
        out.errors += 1;
        this.log.warn('gocomet target-price hydration failed', { enquiry: rec.enquiryKey, err: e && e.message });
      }
    }
    for (const rec of this.watched()) {
      if (nowMs >= rec.watchUntil) { this.records.delete(rec.id); out.expired += 1; }
    }
    // Settled target records age out too. Nothing else deletes them - both cleanup paths were
    // watch-kind-only - so the store grew without bound on a box we do not own, and every boot's
    // rehydrate walked the whole set. Retained well past the window so a restart can still report
    // what a missed one was worth, then dropped.
    for (const rec of this.records.values()) {
      if (rec.kind !== 'target' || rec.status === 'open') continue;
      const settledAt = rec.answeredAt || rec.expiredAt || rec.seenAt || 0;
      if (settledAt && nowMs - settledAt >= SETTLED_RETENTION_MS) {
        this.records.delete(rec.id); out.pruned = (out.pruned || 0) + 1;
      }
    }
    out.expired += await this._sweepExpired(nowMs);
    this._persist();
    return out;
  }

  async _hydrate(enquiryKey, nowMs) {
    if (!this.adapter || typeof this.adapter.fetchTargetPrice !== 'function') return null;
    return this.adapter.fetchTargetPrice(enquiryKey, { nowMs });
  }

  /**
   * Record a newly-seen target and hand it to the desk. Keyed by round, so a second power
   * negotiation on the same load raises a fresh ask against its own deadline rather than merging
   * into the first - which is what the auctionId-keyed durable scheduler would have done.
   */
  async _raise(rec, facts, nowMs) {
    const round = roundFor(facts);
    const id = TargetPriceWatch.recordId(rec.enquiryKey, round);
    if (this.records.has(id)) return false;
    const target = {
      id, kind: 'target', status: 'open',
      enquiryKey: rec.enquiryKey, round,
      loadSnapshot: rec.loadSnapshot,
      targetPricePerUnit: facts.targetPricePerUnit,
      standingPricePerUnit: facts.standingPricePerUnit,
      targetDeadlineMs: facts.targetDeadlineMs,
      comment: facts.comment,
      chargeLineCount: facts.chargeLineCount,
      autoBiddable: facts.autoBiddable,
      seenAt: nowMs,
    };
    this.records.set(id, target);
    this._persist();
    this.log.info('gocomet target rate seen', {
      enquiry: rec.enquiryKey, round, target: facts.targetPricePerUnit,
      standing: facts.standingPricePerUnit, deadlineMs: facts.targetDeadlineMs,
      windowMs: facts.targetDeadlineMs - nowMs, lines: facts.chargeLineCount,
    });
    // A FAILED HAND-OFF MUST NOT CONSUME THE ASK. The record is written before onTarget so a
    // crash between the two cannot lose it - but if onTarget throws (the price request could not
    // be created, the send blew up), the record's existence is what makes the next poll return
    // early, so the desk is never asked at all and the only thing that ever mentions the load
    // again is the expiry alert saying nobody replied. Roll it back and let the next poll retry;
    // the window is minutes long and there are several polls left in it.
    try {
      await this.onTarget(target);
    } catch (e) {
      this.records.delete(id);
      this._persist();
      this.log.error('gocomet target rate could not be handed to the desk - rolled back for retry', {
        enquiry: rec.enquiryKey, round, err: e && e.message,
      });
      throw e;
    }
    return true;
  }

  async _sweepExpired(nowMs) {
    let n = 0;
    for (const rec of this.pending()) {
      if (nowMs < rec.targetDeadlineMs) continue;
      rec.status = 'expired';
      rec.expiredAt = nowMs;
      n += 1;
      this.log.warn('gocomet target rate window closed unanswered', {
        enquiry: rec.enquiryKey, round: rec.round, target: rec.targetPricePerUnit,
      });
      await this.onExpired(rec);
    }
    return n;
  }

  /** Mark a target answered, so the expiry sweep stops treating it as a live obligation. */
  answer(id, { price, outcome } = {}) {
    const rec = this.records.get(id);
    if (!rec || rec.kind !== 'target') return null;
    rec.status = 'answered';
    rec.answeredAt = this.now();
    rec.answeredPrice = price != null ? price : null;
    rec.outcome = outcome || null;
    this._persist();
    return rec;
  }

  /**
   * Boot-time re-assertion. Three outcomes, mirroring the engine's own rehydrate split, but sized
   * to THIS window rather than to an auction's: the shortest window observed is 13m45s, so a deploy
   * is a material fraction of it and "the deadline passed while we were down" is a likely state,
   * not an edge case. A still-open target is re-surfaced rather than assumed delivered, because a
   * duplicate ask costs a message and a dropped one costs the load.
   */
  async rehydrate(nowMs = this.now()) {
    const out = { reasserted: 0, missed: 0, dropped: 0, corrupt: this.corrupt };
    if (this.corrupt) {
      this.log.error('gocomet target-price store was unreadable and has been backed up; live windows may have been lost', { filePath: this.filePath });
    }
    for (const rec of [...this.records.values()]) {
      if (rec.kind === 'watch') {
        if (nowMs >= rec.watchUntil) { this.records.delete(rec.id); out.dropped += 1; }
        continue;
      }
      if (rec.status !== 'open') continue;
      if (nowMs < rec.targetDeadlineMs) {
        out.reasserted += 1;
        this.log.info('gocomet target rate still live after restart', {
          enquiry: rec.enquiryKey, round: rec.round, msLeft: rec.targetDeadlineMs - nowMs,
        });
        await this.onTarget(rec, { reasserted: true });
      } else {
        rec.status = 'expired';
        rec.expiredAt = nowMs;
        rec.expiredWhileDown = true;
        out.missed += 1;
        this.log.warn('gocomet target rate window closed while the process was down', {
          enquiry: rec.enquiryKey, round: rec.round, target: rec.targetPricePerUnit,
        });
        await this.onExpired(rec);
      }
    }
    this._persist();
    return out;
  }
}

// GoComet exposes no round id on the quote, only a counter on the enquiry detail. Falling back to
// the deadline keeps two rounds distinct even when the counter is not to hand, because a new round
// always carries a new deadline.
function roundFor(facts) {
  if (Number.isFinite(facts.negotiationRound)) return `r${facts.negotiationRound}`;
  return `d${facts.targetDeadlineMs}`;
}

module.exports = { TargetPriceWatch, DEFAULT_WATCH_MS, DEFAULT_POLL_MS, DEFAULT_MAX_POLLS_PER_CYCLE, SETTLED_RETENTION_MS };
