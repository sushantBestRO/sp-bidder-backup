'use strict';

const { MAX_PLAUSIBLE_DEADLINE_MS } = require('./realAdapter');

/**
 * GoComet "Target Rate" - the shipper reopens a load for us alone, at a stated price, with its own
 * deadline. Pure parsing and classification; no I/O, so every branch below is pinned against the
 * captured probe bodies in scripts/test-gocomet-target-price.js.
 *
 * THE EVENT ARRIVES AFTER THE AUCTION CLOSES. Measured on both captured instances:
 * 260817N3VH closed 19:59:59 and the target landed 20:46:15 (46 min later, deadline 21:00);
 * 260817Q9LG closed 17:44:59 and the target landed 18:03:05 (18 min later, deadline 19:02).
 * That is why this cannot ride the auction monitor - the engine has finalized the load by then.
 *
 * AND IT IS NOT ONLY SENT ON LOADS WE WON. Q9LG was rank 2 at close and still received a target of
 * Rs 1,90,000; nobody answered and it settled Lost at rank 5. So the watch set is "loads we quoted",
 * not "loads we won" - a narrower set would have missed the one instance that actually cost money.
 */

// GoComet writes this deadline ONLY as a display string - there is no ISO sibling the way
// bid_close_timestamp shadows bid_close_time. Date.parse cannot read it: V8 reads "17/08/2026" as
// month 17 and returns NaN, and on a date like "05/08/2026" it would silently read it as 5 August
// in US order and be wrong by months without erroring. Hence an explicit parse.
const DEADLINE_RE = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?(?:\s*(?:IST|UTC\s*\+05:?30))?$/i;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Parse GoComet's "17/08/2026 21:00" deadline to epoch ms, bounded like the adapter's own
 * _boundedParseMs so an absurd or stale value fails closed rather than arming a fake runway.
 * The value is minute-truncated at source (GoComet does the same to bid_close_time), so it is
 * taken as the LAST second of that minute - the same convention bid_close_timestamp uses when it
 * renders 19:59 as 19:59:59.
 */
function parseTargetDeadlineMs(raw, nowMs = Date.now()) {
  if (typeof raw !== 'string') return null;
  const m = DEADLINE_RE.exec(raw.trim());
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min, ss] = m;
  const day = Number(dd), month = Number(mm), hour = Number(hh), minute = Number(min);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const seconds = ss != null ? Number(ss) : 59;
  const utcMs = Date.UTC(Number(yyyy), month - 1, day, hour, minute, seconds) - IST_OFFSET_MS;
  // Round-trip guard: Date.UTC rolls 31/02 forward into March rather than rejecting it.
  const back = new Date(utcMs + IST_OFFSET_MS);
  if (back.getUTCDate() !== day || back.getUTCMonth() !== month - 1) return null;
  if (utcMs < nowMs - MAX_PLAUSIBLE_DEADLINE_MS || utcMs > nowMs + MAX_PLAUSIBLE_DEADLINE_MS) return null;
  return utcMs;
}

/**
 * negotiation_status, as observed. 'negotiation_no_reply' is the expensive one: it means a target
 * was posted and the window closed with no answer from us.
 *
 * The indicative fields are CLEARED once that happens - Q9LG carries negotiation_no_reply with a
 * null price and a null deadline even though the notification feed still shows the Rs 1,90,000 that
 * was offered. So the money is only readable WHILE the window is open (or after a completed reply),
 * and a design that hydrates lazily after the fact reads nulls on exactly the loads it exists for.
 */
const NEGOTIATION_LIVE = 'negotiation_in_progress';
const NEGOTIATION_NO_REPLY = 'negotiation_no_reply';
const NEGOTIATION_COMPLETE = 'negotiation_complete';
const NEGOTIATION_NONE = 'not_negotiated';

/**
 * Pull the target-rate facts off a GET /enquiries/{key}/quotes body (an array of quote objects).
 * Returns null when the body carries no target at all.
 *
 * PRICE IS PER UNIT. The notification renders the same number under "Target Rate Per Unit", and the
 * quote's own charge line pairs price with a units multiplier. Treating it as a load total would
 * underbid an N-truck load by a factor of N, so it is named for what it is and never totalled here.
 */
function readTargetPrice(quotesBody, nowMs = Date.now()) {
  const quotes = Array.isArray(quotesBody) ? quotesBody : (quotesBody && quotesBody.quote ? [quotesBody.quote] : null);
  if (!quotes || !quotes.length) return null;
  const q = quotes.find((x) => x && x.indicative_charges_list) || quotes[0];
  if (!q) return null;
  const ind = q.indicative_charges_list || {};
  const negotiate = ind.negotiate_data || {};
  const status = q.negotiation_status || NEGOTIATION_NONE;
  const rawPrice = ind.total_charge ? ind.total_charge.price : null;
  const price = Number.isFinite(Number(rawPrice)) && Number(rawPrice) > 0 ? Number(rawPrice) : null;
  const deadlineMs = parseTargetDeadlineMs(negotiate.deadline, nowMs);
  if (status === NEGOTIATION_NONE && price == null && deadlineMs == null) return null;
  const lines = countChargeLines(q);
  return {
    negotiationStatus: status,
    isNegotiating: q.is_negotiating === true,
    targetPricePerUnit: price,
    targetDeadlineMs: deadlineMs,
    // Number of freight-charge lines (truck types) on the quote. Load-bearing: the target is quoted
    // in "one of each line" space - verified arithmetically, total_per_unit_by_quote equals the SUM
    // of the per-line prices (Q9LG 113505+102695=216200, KQIF 95710+106970=202680). The write path
    // Since #214 the write path CAN price an N-line quote, but only by writing one uniform per-unit
    // rate to every line - so hitting a summed target would mean inventing a split across truck
    // types that carry different trucks, which nothing here has evidence for. Carried so the desk
    // is told to re-quote by hand rather than the split being guessed.
    chargeLineCount: lines,
    autoBiddable: lines === 1,
    // Free text from the shipper ("Immediate Requirement"). Display only - never parsed for money.
    comment: typeof negotiate.comment === 'string' && negotiate.comment.trim() ? negotiate.comment.trim() : null,
    // Our standing number on the load, for the "they want X against our Y" line the desk reads.
    standingPricePerUnit: readStandingPrice(q),
    quoteKey: q.key || null,
    enquiryVendorId: q.enquiry_vendor_id || null,
    currency: (ind.total_charge && ind.total_charge.currency) || 'INR',
  };
}

/**
 * The freight lines placeBid would actually price - the SAME set, resolved the same way, because
 * chargeLineCount decides whether we refuse a load as multi-truck-type and the two must not
 * disagree about what a "line" is.
 *
 * Two divergences this closes. The group key was hardcoded to '11_freight_charges', so a tenant
 * whose group is numbered differently read ZERO lines - and zero fails the `> 1` multi-line guard
 * OPEN on a genuinely multi-type quote. And every key except display_name was counted as a truck
 * type, but the same container also holds ACCESSORIAL lines - `lr_charges` and `others` both
 * appear inside it on the atgtire tenant - so a single-truck load carrying one accessorial read as
 * two truck types and was refused with "enter it on the portal by hand" for no reason.
 *
 * More than one freight GROUP returns nothing: placeBid refuses that shape outright
 * (MULTI_FREIGHT_GROUP), so there is no single number to reason about and no target to act on.
 */
function freightLines(q) {
  const cl = q && q.charges_list;
  if (!cl || typeof cl !== 'object') return [];
  const groups = Object.keys(cl).filter((k) => /_freight_charges$/.test(k) && cl[k] && typeof cl[k] === 'object');
  if (groups.length !== 1) return [];
  const list = cl[groups[0]];
  return Object.entries(list)
    .filter(([k, v]) => k.startsWith('freight_charges_custom_charge') && v && typeof v === 'object');
}

function countChargeLines(q) {
  return freightLines(q).length;
}

// Summed across lines, which is what puts it in the same space as the target: the platform's own
// total_charges.total.total_per_unit_by_quote equals this sum on every captured body.
function readStandingPrice(q) {
  let total = null;
  for (const [, v] of freightLines(q)) {
    const p = Number(v.price);
    if (Number.isFinite(p) && p > 0) total = (total == null ? 0 : total) + p;
  }
  return total;
}

/**
 * Is there an actionable target right now? Actionable means: a real number, a deadline still in the
 * future, and a status that has not already settled. A missing price with a live deadline is NOT
 * actionable - without the number there is nothing to put in front of the desk.
 */
function isActionableTarget(facts, nowMs = Date.now()) {
  if (!facts) return false;
  if (facts.negotiationStatus === NEGOTIATION_COMPLETE || facts.negotiationStatus === NEGOTIATION_NO_REPLY) return false;
  if (facts.targetPricePerUnit == null || facts.targetDeadlineMs == null) return false;
  return facts.targetDeadlineMs > nowMs;
}

/**
 * LEGAL WALL. rank_changed notifications name the carrier that displaced us, with their company and
 * a working email address - both captured instances do (TRANS CONNECT LOGICTICS L / suratroadking,
 * and DGS Translogistics). Modelling a rival from that is coordination risk under Competition Act
 * s.3(3)(d), so it is dropped HERE, at the parse boundary, and never reaches storage or a log line.
 * Our own rank is kept: it is a density signal about the field, not an identity.
 */
function stripRivalIdentity(notification) {
  if (!notification || typeof notification !== 'object') return null;
  const intent = notification.channel_intent || null;
  const out = {
    intent,
    createdAt: notification.created_at_with_seconds || notification.created_at || null,
    enquiryKey: (notification.web_data && notification.web_data.item_details) || null,
  };
  if (intent === 'rank_changed') return out;         // subject + created_by both name the rival
  const by = notification.created_by || {};
  // Kept only for shipper-authored events, where the author is the customer rather than a competitor.
  out.subject = notification.subject || null;
  out.message = notification.message || null;
  out.authorCompany = by.role && String(by.role).startsWith('client') ? (by.company_name || null) : null;
  return out;
}

/**
 * The target-rate event on the notification feed. Kept as a SECOND source rather than the primary
 * one: reaching this feed costs an enquiry_vendor_id that only /quotes carries, so it is the more
 * expensive route. Its value is that it retains the numbers after expiry, which /quotes does not -
 * which makes it the only way to report what a missed window would have been worth.
 */
const TARGET_INTENT = 'quote_indicative';

function parseTargetFromNotification(notification, nowMs = Date.now()) {
  const safe = stripRivalIdentity(notification);
  if (!safe || safe.intent !== TARGET_INTENT) return null;
  const msg = safe.message || '';
  const cells = [...msg.matchAll(/<td[^>]*>\s*([^<]*?)\s*<\/td>/gi)].map((m) => m[1].trim());
  const nums = cells.map(toNumber).filter((n) => n != null);
  const deadline = /Deadline:\s*<\/b>\s*([0-9/]{10}\s+[0-9:]{5})/i.exec(msg);
  const comment = /Comments:\s*<\/b>\s*([^<]+)/i.exec(msg);
  return {
    enquiryKey: safe.enquiryKey,
    standingPricePerUnit: nums.length >= 2 ? nums[0] : null,
    targetPricePerUnit: nums.length >= 2 ? nums[nums.length - 1] : null,
    targetDeadlineMs: deadline ? parseTargetDeadlineMs(deadline[1], nowMs) : null,
    comment: comment ? comment[1].trim() : null,
    postedAt: safe.createdAt,
  };
}

// "1,02,695.0" - Indian digit grouping, so a plain Number() on the raw string returns NaN.
function toNumber(s) {
  if (typeof s !== 'string') return null;
  const cleaned = s.replace(/[,\s]/g, '').replace(/INR/i, '');
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

module.exports = {
  parseTargetDeadlineMs,
  readTargetPrice,
  isActionableTarget,
  stripRivalIdentity,
  parseTargetFromNotification,
  TARGET_INTENT,
  NEGOTIATION_LIVE,
  NEGOTIATION_NO_REPLY,
  NEGOTIATION_COMPLETE,
  NEGOTIATION_NONE,
};
