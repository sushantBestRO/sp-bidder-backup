'use strict';

const { iso, pipe, bool, json } = require('./csv');
const { addressesByKind } = require('../notify/waTemplates');
const { platformOf } = require('../pricing/priceRequests');

/**
 * Export registry for the /api/export/* CSV endpoints (docs/CSV_EXPORTS_SCOPE.md).
 *
 * A factory over the same data seams every read endpoint already uses — the
 * BidLogger, the PriceRequestStore, and the store's append-only event streams — so
 * it is unit-testable with a memory store and needs no HTTP boot. Each builder
 * returns a plain { headers, rows } projection; the caller serializes it with
 * csv.toCsv and sets the download headers. SCOPE: our-side data only (our bids,
 * outcomes, requests, alerts, audit) — no competitor ladder (that is the +60k
 * slice and is not logged here).
 *
 * PORTAL SCOPE: every builder here is deliberately ALL-PORTAL, with an explicit `platform`
 * column on each row of the three record streams. GoComet runs in this same process (one
 * `stacks` array, one PriceRequestStore), and one operator desk works both portals - so a
 * download that silently dropped the GoComet rows the same desk priced would be wrong, not
 * merely incomplete. The rule the whole platform-scoping change settles on: a scoped reader
 * prevents silent corruption, and an explicit platform column makes corruption impossible to
 * be SILENT - which one applies depends on whether a human sees the rows. These are files a
 * human opens, so they get the column. The client-facing aggregates (the participation and win
 * percentages in notify/directorEod.js, notify/eodReport.js, notify/heartbeat.js and
 * /api/export/summary) have no per-row surface to carry a label, and stay scoped.
 *
 * That is also why this factory takes NO platformKey. It had one and used it in exactly one of
 * six builders, which certified the file as "scoped" while two closed-bid builders read every
 * portal unlabelled; a parameter that half the builders ignore is worse than no parameter,
 * because the gate and the reader both believe it.
 */

const LOG_WINDOW_MS = 90 * 86_400_000; // default lookback for the day-file log streams

// Accept an ISO date string OR epoch-ms in from/to; either bound may be absent.
function parseRange(q = {}) {
  const one = (v) => {
    if (v == null || v === '') return null;
    const p = Date.parse(v);
    if (!Number.isNaN(p)) return p;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return { from: one(q.from), to: one(q.to) };
}

// store.readEvents enumerates day-files across a concrete [from,to] (no range =
// today only), so the log-backed streams always resolve to a bounded window.
function logRange({ from, to }, now = Date.now()) {
  const hi = to != null ? to : now;
  const lo = from != null ? from : hi - LOG_WINDOW_MS;
  return { from: lo, to: hi };
}

// Full route split by kind, as two columns (pickupPoints/dropPoints) rather than one
// kind-prefixed column, so a spreadsheet consumer needs no parsing to filter by kind.
// addressesByKind() is the same shared join notify/waTemplates.js's dropAddress() builds on.
function pointsCols(points) {
  return { pickupPoints: addressesByKind(points, 'pickup'), dropPoints: addressesByKind(points, 'drop') };
}

function makeExporters({ store, bidLogger, requests }) {
  // Export 1 — bid history: one row per closed auction, every portal, labelled.
  async function bidHistory({ from, to }) {
    const rows = await bidLogger.listClosed({ from, to });
    const headers = ['auctionId', 'platform', 'account', 'shipper', 'origin', 'destination', 'equipment', 'units',
      'cost', 'costFloor', 'floor', 'openingBid', 'floorBid', 'lastBidPrice', 'numBids', 'marginBand',
      'minMarginPct', 'finalRank', 'won', 'anyBid', 'closeModel', 'armedAt', 'closedAt', 'status',
      'pickupPoints', 'dropPoints'];
    const out = rows.map((r) => {
      const ladder = Array.isArray(r.ladder) ? r.ladder : [];
      const bids = Array.isArray(r.ourBids) ? r.ourBids : [];
      const lane = r.lane || {};
      const pc = pointsCols(r.points);
      return [
        r.auctionId, platformOf(r), r.account && r.account.label ? r.account.label : '', r.shipper || '',
        lane.origin || '', lane.destination || '', r.equipment || '', r.units != null ? r.units : '',
        r.cost != null ? r.cost : '', r.costFloor != null ? r.costFloor : '', r.floor != null ? r.floor : '',
        ladder.length ? ladder[0] : '', ladder.length ? ladder[ladder.length - 1] : '',
        r.lastBidPrice != null ? r.lastBidPrice : '', bids.length, pipe(r.marginsPct),
        r.minMarginPct != null ? r.minMarginPct : '', r.finalRank != null ? r.finalRank : '', bool(r.won),
        bool(bids.length > 0), r.closeModel || '',
        iso(r.armedAt), iso(r.closedAt), r.status || '',
        pc.pickupPoints, pc.dropPoints,
      ];
    });
    return { headers, rows: out };
  }

  // Export 2 — bid detail: one row per individual bid, auction context repeated. The portal is
  // part of that repeated context for the same reason the rest of it is: principle 6 of the scope
  // doc says every row stands alone, and a bid row whose portal can only be recovered by joining
  // back to bid-history does not.
  async function bidDetail({ from, to }) {
    const auctions = await bidLogger.listClosed({ from, to });
    const headers = ['auctionId', 'platform', 'shipper', 'origin', 'destination', 'bidNumber', 'bidTs',
      'rungIndex', 'price', 'rank', 'latencyMs', 'pickupPoints', 'dropPoints'];
    const out = [];
    for (const r of auctions) {
      const lane = r.lane || {};
      const bids = Array.isArray(r.ourBids) ? r.ourBids : [];
      const pc = pointsCols(r.points);
      // SAME RANK EXPRESSION AS exportModel.bidsView, and it has to stay the same one. `b.rank` is
      // the rank the platform returned on the bid response and is frequently absent; `b.socketRank`
      // is the rank the live socket reported for that bid and is usually the one that exists. This
      // file read only the former and the newer exporter reads socketRank first, so the two live
      // exporters answered a rank question differently for the identical bid - '' here against 9
      // there on load 25118167. Two exports of one system that disagree on a number is the failure
      // mode the desk reports as "the data is coming wrong", and it is worse than either answer.
      bids.forEach((b, i) => out.push([
        r.auctionId, platformOf(r), r.shipper || '', lane.origin || '', lane.destination || '', i + 1, iso(b.ts),
        b.rungIndex != null ? b.rungIndex : '', b.price != null ? b.price : '',
        b.socketRank != null ? b.socketRank : (b.rank != null ? b.rank : ''),
        b.latencyMs != null ? b.latencyMs : '',
        pc.pickupPoints, pc.dropPoints,
      ]));
    }
    return { headers, rows: out };
  }

  // Export 3 — price requests: one row per request (current funnel; the store prunes
  // ~7d after close, so this is the live window, not deep history). All-portal + labelled, like
  // its two siblings above: this file and bid-history are routinely opened side by side, and a
  // pair where one is silently SP-only and the other is not is how an analyst gets a
  // participation denominator that does not match its numerator.
  async function priceRequests({ from, to }) {
    let reqs = await requests.listAll();
    if (from != null) reqs = reqs.filter((r) => (r.createdAt || 0) >= from);
    if (to != null) reqs = reqs.filter((r) => (r.createdAt || 0) <= to);
    reqs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const headers = ['loadId', 'platform', 'account', 'shipper', 'origin', 'destination', 'equipment', 'units',
      'productName', 'status', 'marginSource', 'marginBand', 'minMarginPct', 'cost', 'createdAt',
      'deadlineAt', 'capturedAt', 'timeToPriceMins', 'closesAt', 'softClose', 'pickupPoints', 'dropPoints'];
    const out = reqs.map((r) => {
      const load = r.load || {};
      const lane = load.lane || {};
      const cost = r.price && r.price.cost != null ? r.price.cost : '';
      const ttp = (r.capturedAt && r.createdAt) ? Math.round((r.capturedAt - r.createdAt) / 60_000) : '';
      const pc = pointsCols(load.points);
      return [
        r.loadId || '', platformOf(r), r.account && r.account.label ? r.account.label : '', load.companyName || '',
        lane.origin || '', lane.destination || '', load.equipment || '', load.units != null ? load.units : '',
        load.productName || '', r.status || '', r.marginSource || '', pipe(r.marginsPct),
        r.minMarginPct != null ? r.minMarginPct : '', cost, iso(r.createdAt), iso(r.deadlineAt),
        iso(r.capturedAt), ttp, iso(load.closesAt), bool(load.softClose),
        pc.pickupPoints, pc.dropPoints,
      ];
    });
    return { headers, rows: out };
  }

  // Export 4 — alert delivery: one row per WhatsApp send attempt.
  async function notifications(range) {
    const { from, to } = logRange(range);
    const ev = (await store.readEvents('notifications', { from, to })).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const headers = ['ts', 'kind', 'to', 'name', 'ok', 'error', 'messageId'];
    const out = ev.map((e) => [iso(e.ts), e.kind || '', e.to || '', e.name || '', bool(e.ok), e.error || '', e.messageId || '']);
    return { headers, rows: out };
  }

  // Export 5 — config audit: one row per changed field (flatten the changes[] diff).
  async function configAudit(range) {
    const { from, to } = logRange(range);
    const ev = (await store.readEvents('configChanges', { from, to })).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const headers = ['ts', 'actor', 'ip', 'field', 'before', 'after'];
    const out = [];
    for (const e of ev) {
      const changes = Array.isArray(e.changes) ? e.changes : [];
      if (!changes.length) { // a save logged without a per-field diff -> one summary row
        out.push([iso(e.ts), e.actor || '', e.ip || '', pipe(e.changed), '', '']);
        continue;
      }
      for (const c of changes) out.push([iso(e.ts), e.actor || '', e.ip || '', c.field || '', json(c.before), json(c.after)]);
    }
    return { headers, rows: out };
  }

  // Export 6 — engine mode: one row per kill/resume/go_live/stand_down action.
  async function engineMode(range) {
    const { from, to } = logRange(range);
    const ev = (await store.readEvents('engineMode', { from, to })).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const headers = ['ts', 'action', 'actor', 'ip', 'reason', 'target', 'wasLive', 'armed'];
    const out = ev.map((e) => [
      iso(e.ts), e.action || '', e.actor || '', e.ip || '', e.reason || '', e.target || '',
      e.wasLive != null ? bool(e.wasLive) : (e.wasLiveAtKill != null ? bool(e.wasLiveAtKill) : ''),
      e.armed != null ? e.armed : '',
    ]);
    return { headers, rows: out };
  }

  const STREAMS = {
    'bid-history': bidHistory,
    'bid-detail': bidDetail,
    'price-requests': priceRequests,
    notifications,
    'config-audit': configAudit,
    'engine-mode': engineMode,
  };

  return {
    keys: () => Object.keys(STREAMS),
    has: (k) => Object.prototype.hasOwnProperty.call(STREAMS, k),
    parseRange,
    build: (k, range) => STREAMS[k](range),
  };
}

module.exports = { makeExporters, parseRange, logRange, LOG_WINDOW_MS };
