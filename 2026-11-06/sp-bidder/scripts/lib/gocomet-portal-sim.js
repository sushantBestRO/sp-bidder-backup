'use strict';
/**
 * A fake GoComet vendor API on the virtual clock (scripts/lib/virtual-time.js), for driving the real
 * GoCometAdapter and the real BidEngine together. One account, any number of enquiries.
 *
 * bidding-data answers from each enquiry's close against the virtual clock, with a server stamp. A
 * submit before the close is accepted (quote_rank 1, bid_closing_in unchanged, so no extension); one
 * at or after it gets GoComet's 422. Every request takes `getMs` / `putMs` of virtual time.
 *
 * Not a test file - it does not match scripts/test-*.js and the runner never executes it directly.
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const vt = require('./virtual-time');
const { GoCometAdapter } = require('../../src/platform/gocometAdapter');
const { BidEngine } = require('../../src/engine/bidEngine');
const { DurableScheduler } = require('../../src/scheduler/durableScheduler');

const FREIGHT = 'freight_charges_custom_charge_40ft';
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function token() {
  return `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(vt.now() / 1000) + 30 * 86400,
    user_id: 'u1', client_id: 'c1', token_type: 'vendor' })}.sig`;
}
function resp(status, body) {
  return { status, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}
function quoteDoc(id, price) {
  return { id, charges_list: { '11_freight_charges': { [FREIGHT]: { units: 1, unit_name: 'TRUCK', price } } },
    total_charges: { total: { units: 1.0, quote_units: 1.0, unit_name: 'TRUCK', total: price } } };
}
function keyOf(url) {
  const m = /\/enquiries\/([^/?]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

let fileSeq = 0;
const CLEAN = [];
process.on('exit', () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } });

/**
 * enquiries: [{ key, closeAt, rank, rankAt? }]; rankAt(t) scripts a rival's moves until our first accept. Returns the adapter, the engine and the wire log.
 */
function createGoCometAccount({ enquiries, getMs = 40, putMs = 1_200, engineConfig = {}, onEvent = null, bidEnabled = true,
  rankAfterSubmit = 1 }) {
  const byKey = new Map(enquiries.map((e) => [e.key, { ...e, quoteId: `Q-${e.key}` }]));
  const wire = [];
  const byQuote = new Map([...byKey.values()].map((e) => [e.quoteId, e]));
  const fetchImpl = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const sentAt = vt.now();
    await vt.sleep(method === 'PUT' ? putMs : getMs);
    const at = vt.now();
    const qm = /\/quotes\/([^/]+)\/submit/.exec(url);
    const e = qm ? byQuote.get(decodeURIComponent(qm[1])) : byKey.get(keyOf(url));
    const kind = qm ? 'submit' : url.includes('/bidding-data') ? 'state' : url.includes('/quotes') ? 'quotes' : 'other';
    const rec = { kind, method, key: e ? e.key : null, sentAt, at, status: 404 };
    wire.push(rec);
    if (!e) return resp(404, {});
    const secsLeft = Math.round((e.closeAt - at) / 1000);
    const open = at < e.closeAt;
    if (kind === 'state') {
      rec.status = 200;
      return resp(200, { data: { bid_closing_in: open ? Math.max(1, secsLeft) : null, bid_opening_in: null,
        vendor_rank: typeof e.rankAt === 'function' ? e.rankAt(at) : e.rank, revisions_left: 3, total_revisions: 0, current_server_time: new Date(at).toISOString() } });
    }
    if (kind === 'quotes') { rec.status = 200; return resp(200, [quoteDoc(e.quoteId, 40_000)]); }
    if (kind === 'submit') {
      const body = JSON.parse(init.body);
      rec.price = body && body.quote && body.quote.charges_list['11_freight_charges'][FREIGHT].price;
      if (!open) { rec.status = 422; return resp(422, { errors: ['Cannot Submit Quote either the enquiry is closed'] }); }
      rec.status = 200;
      e.rank = rankAfterSubmit;
      e.rankAt = null;
      return resp(200, { data: { ...quoteDoc(e.quoteId, rec.price), quote_rank: rankAfterSubmit, can_submit_quote: true,
        bid_closing_in: Math.max(1, secsLeft) } });
    }
    return resp(404, {});
  };
  const adapter = new GoCometAdapter({ token: token(), userId: 'u1', bidEnabled, fetchImpl, sleep: vt.sleep,
    now: vt.now, log: quiet, minGetIntervalMs: 5_000, globalMinGetIntervalMs: 1_000, snipeBudgetMs: 4_500 });
  const file = path.join(os.tmpdir(), `gc-sim-${process.pid}-${fileSeq += 1}.json`);
  CLEAN.push(file, `${file}.tmp`);
  const events = [];
  const engine = new BidEngine(adapter, new DurableScheduler(file), {
    config: Object.assign({ openJitterMs: 0, softOpenJitterMs: 0, cadenceJitterMs: 0 }, engineConfig),
    softClose: { enabled: false, shippers: [], mode: 'live' }, rand: () => 0.5, log: quiet,
    onEvent: (ev) => { events.push(ev); if (onEvent) onEvent(ev); },
  });
  return { adapter, engine, wire, events, byKey };
}

function armGoComet(account, key, { cost = 36_000, marginsPct = [9, 7.2, 1.8, 1] } = {}) {
  const e = account.byKey.get(key);
  return account.engine.arm({ id: key, lane: { origin: 'Degam', destination: 'Surat' }, equipment: '40 ft', units: 1,
    quoteType: 'FTL', companyName: 'Waaree Energies Ltd', branchName: 'Degam', closesAt: e.closeAt, status: 'live',
    platformKey: 'gocomet', rules: { revisionLimit: 3, minDecrement: 500 } }, { cost, marginsPct });
}

module.exports = { createGoCometAccount, armGoComet };
