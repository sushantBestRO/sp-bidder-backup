'use strict';
/**
 * Shared harness for the result-receipt tests: engine events -> the real BidLogger (memory store)
 * -> the closed-bids record -> the real notifyEngineEvent -> the real template selection and
 * renderer. Nothing on that path is stubbed, so a receipt test exercises what the bid record
 * persists as well as what the message says.
 *
 * The receipts print server-local time and the box runs in IST, so TZ is pinned here: CI runs in
 * UTC and would otherwise render every clock five and a half hours off. Require this module before
 * constructing any Date.
 *
 * Not a test file - it does not match scripts/test-*.js and the runner never executes it directly.
 */

process.env.TZ = 'Asia/Kolkata';

const { createStore } = require('../../src/store');
const { BidLogger } = require('../../src/logging/bidLogger');
const { notifyEngineEvent } = require('../../src/notify/engineAlerts');
const { renderMessage, templateFor } = require('../../src/notify/waTemplates');

const IST_OFFSET_MS = 19_800_000;

/** Epoch ms of an IST wall-clock instant, independent of the machine's zone. month is 1-12. */
function istAt(y, month, d, h, mi, s = 0, ms = 0) {
  return Date.UTC(y, month - 1, d, h, mi, s, ms) - IST_OFFSET_MS;
}

/**
 * Feed one auction's events through a fresh BidLogger and return the settled record.
 *   armed   - fields for the 'armed' event (cost, companyName, lane, equipment, ...)
 *   events  - engine events in order, each { type: 'bid_placed' | 'bid_rejected', ... }
 *   result  - fields for the 'auction_result' event
 */
async function closeThroughLogger({ auctionId, platformKey = null, armed = {}, events = [], result = {} }) {
  const store = createStore({ backend: 'memory' });
  const logger = new BidLogger({ store, log: () => {} });
  await logger.handle({ type: 'armed', auctionId, platformKey, ...armed });
  for (const e of events) await logger.handle({ auctionId, ...e });
  const resultEvent = { type: 'auction_result', auctionId, ...result };
  await logger.handle(resultEvent);
  const record = await store.getDoc('closedBids', String(auctionId));
  return { store, logger, record, resultEvent };
}

/** Route a result event the way the server does and render the message a recipient gets. */
async function renderResult({ record, resultEvent, platformKey = null, short = false }) {
  const captured = [];
  const notifier = { alert: async (kind, data, opts) => { captured.push({ kind, data, opts }); return true; } };
  await notifyEngineEvent(notifier, resultEvent, null, async () => record, platformKey);
  if (!captured.length) throw new Error('HARNESS: notifyEngineEvent routed nothing for this result');
  const { kind, data } = captured[0];
  const template = templateFor(kind, data, { short });
  return { kind, template, data, text: renderMessage(template, data) };
}

/** Both variants a recipient can receive: the full message (DM, won) and the short group reply. */
async function closeAndRender(opts) {
  const closed = await closeThroughLogger(opts);
  const args = { record: closed.record, resultEvent: closed.resultEvent, platformKey: opts.platformKey || null };
  const full = await renderResult(args);
  const short = await renderResult({ ...args, short: true });
  return { ...closed, full, short };
}

/** The first line carrying the spec's value (and its label, ahead of the value), or null. */
function findLine(text, spec) {
  const lines = String(text || '').split('\n');
  return lines.find((l) => {
    const at = l.indexOf(spec.value);
    if (at === -1) return false;
    if (!spec.label) return true;
    const lab = l.indexOf(spec.label);
    return lab !== -1 && lab < at;
  }) || null;
}

const hasLine = (text, spec) => findLine(text, spec) != null;

module.exports = { istAt, closeThroughLogger, renderResult, closeAndRender, findLine, hasLine, IST_OFFSET_MS };
