'use strict';
/**
 * A fake SuperProcure account on the virtual clock (scripts/lib/virtual-time.js), for driving the real
 * RealSuperProcureAdapter and the real BidEngine together: a socket stand-in holding each load's frame,
 * and a createV2 endpoint. One account, any number of hard-close loads.
 *
 * A write before the close is accepted (201) after `writeMs`; the socket frame then shows our amount
 * `frameMs` later, at `rankAfter(price)` (default: rank 2, a rival always below us, so the engine keeps
 * stepping down). A write at or after the close is refused with SuperProcure's closed wording.
 *
 * Not a test file - it does not match scripts/test-*.js and the runner never executes it directly.
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const vt = require('./virtual-time');
const { RealSuperProcureAdapter } = require('../../src/platform/realAdapter');
const { BidEngine } = require('../../src/engine/bidEngine');
const { DurableScheduler } = require('../../src/scheduler/durableScheduler');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
let fileSeq = 0;
const CLEAN = [];
process.on('exit', () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } });

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** loads: [{ id, closeAt, rank }]. Returns the adapter, the engine, the wire log and the read log. */
function createSuperProcureAccount({ loads, writeMs = 130, frameMs = 150, rankAfter = () => 2, engineConfig = {}, onEvent = null }) {
  const frames = new Map(loads.map((l) => [String(l.id), { myRank: l.rank, myAmount: null, bids: [], loadEndTimeMs: l.closeAt, extended: false }]));
  const closeOf = new Map(loads.map((l) => [String(l.id), l.closeAt]));
  const reads = [];
  const wire = [];
  const sock = {
    watch() {}, noteRoundTrip() {}, registerCarrier() {}, clockErrorMs() { return 50; },
    state(id) { return frames.get(String(id)) || null; },
    closesInMs(id, fallback) {
      const end = closeOf.get(String(id)) || fallback;
      return end ? Math.max(0, end - vt.now()) : null;
    },
  };
  const fetchImpl = async (url, init) => {
    const sentAt = vt.now();
    await vt.sleep(writeMs);
    const at = vt.now();
    const m = /createV2\?id=(\d+)/.exec(url);
    const id = m ? m[1] : null;
    const body = init && init.body ? JSON.parse(init.body) : {};
    const rec = { kind: m ? 'submit' : 'other', id, sentAt, at, price: body.amount, status: 404 };
    wire.push(rec);
    if (!m) return { status: 404, headers: { get: () => null }, text: async () => '' };
    if (at >= closeOf.get(id)) {
      rec.status = 400;
      return { status: 400, headers: { get: () => null }, text: async () => 'Bidding time is over for this load' };
    }
    rec.status = 201;
    const f = frames.get(id);
    vt.sleep(frameMs).then(() => { f.myAmount = body.amount; f.myRank = rankAfter(body.amount); });
    return { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ data: { amount: body.amount, rank: null } }) };
  };
  const token = `${b64url({ alg: 'HS256' })}.${b64url({ exp: Math.floor(vt.now() / 1000) + 300 * 86400, u_id: 1 })}.sig`;
  const adapter = new RealSuperProcureAdapter({ token, sock, fetchImpl, sleep: vt.sleep, authProbeEnabled: false });
  adapter.account = { carrierId: 7, tokenExp: vt.now() + 300 * 86400_000 };
  for (const l of loads) {
    adapter.loadMeta.set(String(l.id), { id: String(l.id), closesAt: l.closeAt, softClose: false, revisionLimit: 10,
      isOpenAuction: false, minDecrement: 100, biddingCloseTime: l.closeAt, biddingOn: true });
    adapter.loadLastSeenAt.set(String(l.id), vt.now());
  }
  const readState = adapter.getAuctionState.bind(adapter);
  adapter.getAuctionState = async (id) => {
    const s = await readState(id);
    reads.push({ id: String(id), at: vt.now(), ok: !!(s && s.ok), closesInMs: s ? s.closesInMs : null });
    return s;
  };
  const file = path.join(os.tmpdir(), `sp-sim-${process.pid}-${fileSeq += 1}.json`);
  CLEAN.push(file, `${file}.tmp`);
  const events = [];
  const engine = new BidEngine(adapter, new DurableScheduler(file), {
    config: Object.assign({ openJitterMs: 0, softOpenJitterMs: 0, cadenceJitterMs: 0 }, engineConfig),
    softClose: { enabled: false, shippers: [], mode: 'live' }, rand: () => 0.5, log: quiet,
    onEvent: (ev) => { events.push(ev); if (onEvent) onEvent(ev); },
  });
  return { adapter, engine, wire, reads, events, frames };
}

function armSuperProcure(account, load, { cost = 50_000, marginsPct = [9, 7.2, 5.4, 3.6] } = {}) {
  return account.engine.arm({ id: String(load.id), lane: { origin: 'Bhiwandi', destination: 'Hosur' }, equipment: '32ft SXL',
    units: 1, quoteType: 'FTL', companyName: 'Tata Steel', branchName: 'Bhiwandi', closesAt: load.closeAt, status: 'live',
    platformKey: 'superprocure', rules: { revisionLimit: 10, minDecrement: 100 } }, { cost, marginsPct });
}

module.exports = { createSuperProcureAccount, armSuperProcure };
