'use strict';

/**
 * Ask-thread store seam - remembers the WhatsApp GROUP messages that carry a load's lifecycle, so
 * later messages can target the right one. Group channel only: the scoped per-customer group is the
 * sole channel for its loads, so there is one thread per (loadId, groupJid). Persisted through the
 * store seam (FileStore/MemoryStore), never raw fs, so it survives a restart like every other piece
 * of app state - the test-store grep gate requires exactly this.
 *
 * TWO handles per (loadId, groupJid) - this separation is the whole point:
 *   - the ASK anchor (messageId / sentAt): the ORIGINAL price-ask message. It carries the rate
 *     request + the /price link and is NEVER edited - every reply (reminder-create, won, lost)
 *     threads onto it, so the outcome always hangs off the pristine ask, not off a mutated bubble.
 *   - the STATUS BUBBLE (bubbleId / bubbleSentAt / link): ONE mutating message that lives between
 *     the ask and the outcome. Created lazily as a reply to the ask on the first status event
 *     (reminder, or rate-received if the desk prices before any reminder), then EDITED in place on
 *     every later transition (rate received -> bidding live -> bid placed) so the group sees one
 *     bubble change state, not a new ping per event. `link` is the reprice/live-status link, stored
 *     when the rate-received edit lands so the later bid-placed edit can show it (bid_live's own
 *     event carries no link). bubbleSentAt is the bubble's ORIGINAL send time - it does NOT move on
 *     an edit, because Maytapi's ~15-min edit window is measured from the original message.
 *
 * Shape, one doc per loadId:
 *   { loadId, groups: [{ jid, messageId, sentAt, bubbleId?, bubbleSentAt?, link? }], updatedAt,
 *     closedAt? }.
 * Bounded, but NOT like the notifier's dedupe set: a dedupe key is disposable and an anchor is not -
 * see sweepAnchors. A re-alert of the ask (recordAsk) resets the group entry, dropping any stale
 * bubble/link - a fresh ask is a fresh anchor and a fresh lifecycle.
 *
 * Every write here goes through the store's NON-BLOCKING document methods. This collection is
 * written from the delivery path of a live auction - the ask, each status transition, each placed
 * bid - and a whole-file read-modify-write of a grown collection is tens of ms of blocked event loop
 * on the same process as the bid monitor and the SP socket.
 */

const { createLogger } = require('../logging/logger');

const log = createLogger('askThread');

const COLLECTION = 'askThreads';
const CAP = 1000;

// An anchor is evictable once its load's thread is OVER: an outcome was delivered (closedAt), or the
// doc has not moved in this long. The horizon exists because a load can end without an outcome ever
// being delivered - never priced, never bid, the customer's group dropped - and those would otherwise
// pin an anchor forever. Auctions here run in hours, so nothing still open is two days quiet.
const STALE_MS = 48 * 60 * 60 * 1000;

// Writes between eviction sweeps. The sweep reads the whole collection, so it is amortised rather
// than run on every write once past the bound.
const SWEEP_EVERY = 50;

// WhatsApp's message-edit window is ~15 min from the original send (Maytapi verified live
// 2026-07-20/21). Past it an edit silently no-ops but STILL returns success:true, so the WINDOW -
// not the ok flag - is what the caller trusts to choose edit-vs-reply. A small safety margin is
// shaved off so a receipt landing right at the boundary is treated as stale (a guaranteed reply)
// rather than gambled on a no-op edit that would look successful and silently vanish.
const EDIT_WINDOW_MS = 15 * 60 * 1000;
const EDIT_SAFETY_MS = 60 * 1000;

function withinEditWindow(sentAt, now = Date.now()) {
  if (!sentAt) return false;
  return (now - Number(sentAt)) < (EDIT_WINDOW_MS - EDIT_SAFETY_MS);
}

/**
 * Record (or overwrite) the ask message for one (loadId, groupJid). A re-alert / re-send of the ask
 * updates the handle so later edits target the LATEST ask, not a stale one. Best-effort by contract:
 * a store error must never break a send, so the caller wraps this in a try/catch.
 */
// `extra.via` is the Maytapi phoneId that actually SENT this ask. It matters because the price-ask
// failover can mint the anchor from a sibling sender when the primary is logged out, and a message id
// minted by one Maytapi phone is not KNOWN to be quotable by another - the edit/reply wire takes a
// reply_to id and nothing in the live probes (2026-07-20/21) tested it across phones. Rather than
// gamble a customer's whole load thread on that, the id is stamped with its sender and
// notifier._deliverGroup ignores a thread whose `via` is not the phone about to use it, degrading to
// a fresh send - the same safe path a missing thread already takes. Absent `via` = a legacy entry
// written before this field existed, and is trusted, so nothing recorded pre-upgrade changes shape.
async function recordAsk(store, loadId, jid, messageId, now = Date.now(), extra = {}) {
  if (!store || !loadId || !jid || !messageId) return;
  const id = String(loadId);
  const existing = await store.getDocAsync(COLLECTION, id);
  const groups = (existing && Array.isArray(existing.groups) ? existing.groups : []).filter((g) => g && g.jid !== jid);
  const entry = { jid, messageId: String(messageId), sentAt: now };
  if (extra && extra.via != null && extra.via !== '') entry.via = String(extra.via);
  groups.push(entry);
  // The new doc deliberately carries no closedAt: a fresh ask REOPENS the thread, so a re-alerted
  // load stops being evictable even if an earlier outcome had closed it.
  await store.putDocAsync(COLLECTION, id, { loadId: id, groups, updatedAt: now });
  // recordAsk is the only writer that adds documents, so it is the only one that owes a sweep.
  if (dueForSweep(store)) await sweepAnchors(store, now);
}

function isClosed(doc, now) {
  if (!doc) return false;
  if (doc.closedAt != null) return true;
  return (now - Number(doc.updatedAt || 0)) > STALE_MS;
}

const writesSinceSweep = new WeakMap();
function dueForSweep(store) {
  const n = (writesSinceSweep.get(store) || 0) + 1;
  writesSinceSweep.set(store, n % SWEEP_EVERY);
  return n >= SWEEP_EVERY;
}

/**
 * Bound the collection without ever breaking a LIVE thread. Only CLOSED anchors are evictable,
 * oldest first. An open load's anchor is the only route its later messages have into its thread, and
 * taking it mid-auction is not a cosmetic loss: the group's bid_live then skips with
 * `no ask thread for bid_live` - no message, no fallback, nothing on the wire - while the bot bids.
 * A plain oldest-first bound evicts exactly the wrong document, because the anchor that has sat
 * longest is a load whose ask went out early and whose auction is still running.
 *
 * If the overflow is entirely open loads, the collection is allowed to GROW, with a warn. An
 * oversized JSON file is housekeeping; a broken thread on a live auction is a lost delivery, and the
 * price-page gate does not trade one for the other.
 */
async function sweepAnchors(store, now = Date.now()) {
  if (!store) return { evicted: 0, over: 0 };
  const all = await store.listDocsAsync(COLLECTION);
  const overflow = all.length - CAP;
  if (overflow <= 0) return { evicted: 0, over: 0 };
  const evictable = all
    .filter((d) => d && d.loadId && isClosed(d, now))
    .sort((a, b) => (a.closedAt || a.updatedAt || 0) - (b.closedAt || b.updatedAt || 0))
    .slice(0, overflow);
  for (const d of evictable) await store.removeDocAsync(COLLECTION, d.loadId);
  const over = overflow - evictable.length;
  if (over > 0) {
    log.warn('over the anchor cap with no closed anchor left to evict - keeping the live threads',
      { cap: CAP, docs: all.length, over });
  }
  return { evicted: evictable.length, over };
}

/**
 * Mark a load's thread CLOSED - an outcome has been delivered, so nothing later will quote this
 * anchor and the sweep may evict it under cap pressure. No-ops on a load with no anchor. Leaves
 * updatedAt alone: that records last activity, and closedAt records the end of the lifecycle.
 * Best-effort by contract, like every other write here.
 */
async function closeAsk(store, loadId, now = Date.now()) {
  if (!store || !loadId) return;
  const id = String(loadId);
  const existing = await store.getDocAsync(COLLECTION, id);
  if (!existing) return;
  await store.putDocAsync(COLLECTION, id, Object.assign({}, existing, { loadId: id, closedAt: now }));
}

/**
 * Record (or update) the STATUS BUBBLE handle for one (loadId, groupJid) - the mutable message the
 * lifecycle edits in place. Attaches onto the EXISTING ask entry (never creates one; if no ask
 * anchor is recorded there is nothing to hang a bubble off, so this no-ops). Two cases:
 *   - a NEW bubble (bubbleId differs from what's stored): set bubbleId AND bubbleSentAt=now - this
 *     is the bubble's original send time, the anchor for the ~15-min edit window;
 *   - the SAME bubble (a later edit carrying a link to remember, e.g. rate-received storing the
 *     reprice link for the eventual bid-placed edit): leave bubbleSentAt untouched, just update the
 *     link. bubbleSentAt must not move on an edit or the window would falsely re-open.
 * `extra.link` (when non-empty) is remembered on the entry either way. Best-effort by contract.
 */
async function recordBubble(store, loadId, jid, bubbleId, now = Date.now(), extra = {}) {
  if (!store || !loadId || !jid || !bubbleId) return;
  const id = String(loadId);
  const existing = await store.getDocAsync(COLLECTION, id);
  const groups = existing && Array.isArray(existing.groups) ? existing.groups : [];
  const g = groups.find((x) => x && x.jid === jid);
  if (!g) return; // no ask anchor for this group -> nothing to attach a bubble to
  if (g.bubbleId !== String(bubbleId)) { g.bubbleId = String(bubbleId); g.bubbleSentAt = now; }
  if (extra.link != null && extra.link !== '') g.link = String(extra.link);
  await store.putDocAsync(COLLECTION, id, Object.assign({}, existing, { loadId: id, groups, updatedAt: now }));
}

// Max bid-log lines retained per (loadId, groupJid). The bid_placed bubble renders only the most
// recent few (waTemplates.BIDLOG_SHOWN) + a "... N earlier" count, but we keep a slightly larger
// tail here so the running total (bidCount) is exact while the stored array stays bounded.
const BIDLOG_KEEP = 12;

/**
 * Append one placed bid to the status bubble's running LOG for (loadId, groupJid) and return the
 * bounded log + running total so the caller can re-render the bubble. Attaches onto the EXISTING
 * ask entry (no-ops if there is no ask anchor or no bubble field yet - the caller only appends once
 * a bubble exists). `bid` is { ts, price, rank }. bidCount is the exact running total across ALL
 * bids; `bids` is capped to the last BIDLOG_KEEP so a many-bid soft-close load can't grow the doc
 * without limit. Best-effort by contract - a store hiccup must never break a send.
 */
async function appendBubbleBid(store, loadId, jid, bid, now = Date.now()) {
  if (!store || !loadId || !jid || !bid) return null;
  const id = String(loadId);
  const existing = await store.getDocAsync(COLLECTION, id);
  const groups = existing && Array.isArray(existing.groups) ? existing.groups : [];
  const g = groups.find((x) => x && x.jid === jid);
  if (!g) return null;
  const prior = Array.isArray(g.bids) ? g.bids : [];
  prior.push({ ts: bid.ts != null ? bid.ts : now, price: bid.price != null ? bid.price : null, rank: bid.rank != null ? bid.rank : null });
  g.bidCount = (Number.isFinite(Number(g.bidCount)) ? Number(g.bidCount) : 0) + 1;
  g.bids = prior.slice(-BIDLOG_KEEP);
  await store.putDocAsync(COLLECTION, id, Object.assign({}, existing, { loadId: id, groups, updatedAt: now }));
  return { bids: g.bids, bidCount: g.bidCount };
}

/**
 * Mark the bubble's most recent bid at `price` as the load's final bid, taking the rank that bid
 * earned when one is given. Returns the updated log, or null when the bubble never logged a bid at
 * that price - the caller then has nothing to fold into and must send its own message.
 */
async function markBubbleFinal(store, loadId, jid, { price, rank = null } = {}, now = Date.now()) {
  if (!store || !loadId || !jid || price == null) return null;
  const id = String(loadId);
  const existing = await store.getDocAsync(COLLECTION, id);
  const groups = existing && Array.isArray(existing.groups) ? existing.groups : [];
  const g = groups.find((x) => x && x.jid === jid);
  const bids = g && Array.isArray(g.bids) ? g.bids : [];
  let i = bids.length - 1;
  while (i >= 0 && !(bids[i] && Number(bids[i].price) === Number(price))) i--;
  if (i < 0) return null;
  bids[i].final = true;
  if (rank != null) bids[i].rank = rank;
  await store.putDocAsync(COLLECTION, id, Object.assign({}, existing, { loadId: id, groups, updatedAt: now }));
  return { bids: g.bids, bidCount: g.bidCount };
}

/**
 * The recorded thread handle for one (loadId, groupJid), or null on any miss - carries BOTH the ask
 * anchor (messageId/sentAt) and the status bubble (bubbleId/bubbleSentAt/link/bids/bidCount) when
 * present. The caller falls back to a fresh send when this is null, so a missing/legacy/DM-only ask
 * never drops a later message.
 */
async function getAskFor(store, loadId, jid) {
  if (!store || !loadId || !jid) return null;
  const doc = await store.getDocAsync(COLLECTION, String(loadId));
  if (!doc || !Array.isArray(doc.groups)) return null;
  return doc.groups.find((g) => g && g.jid === jid) || null;
}

module.exports = {
  COLLECTION, CAP, STALE_MS, SWEEP_EVERY, BIDLOG_KEEP, EDIT_WINDOW_MS, EDIT_SAFETY_MS,
  withinEditWindow, recordAsk, recordBubble, appendBubbleBid, markBubbleFinal, getAskFor, closeAsk, sweepAnchors,
};
