'use strict';
/**
 * An uncertain write whose read-backs all fail is booked as landed and unconfirmed, not as disproved.
 *
 * After a write whose transport failed, the engine reads the portal for our own amount (BC-15 Fix A).
 * Reads that answer and never show our price disprove the write. Reads that never answer (they throw,
 * or come back ok:false) after the first one showed the field are no evidence at all, and the write is booked as before, marked unconfirmed,
 * so the rung is spent and the same price is not sent again. Neither failed-read shape was pinned
 * (PR-2 mutation critique).
 *
 *   node scripts/test-uncertain-write-failed-readback-booked.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const files = [];
process.on('exit', () => { for (const f of files) { try { fs.unlinkSync(f); } catch (_) {} } });
const REMAINING_MS = 114 * 60 * 1000;
let pass = 0;
const ok = (n, m) => { console.log(`  ok  ${n}. ${m}`); pass++; };

async function run(readBack) {
  const wire = [];
  let written = false;
  let readsAfterWrite = 0;
  const live = { ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null, closesInMs: REMAINING_MS,
    revisionsLeft: null, revisionLimit: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100, myAmount: null };
  const adapter = {
    writeEnabled: true,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3,
      closeModel: 'hard', ownBidAmountVisible: true }),
    ensureSession: async () => ({}),
    getAuctionState: async () => {
      if (!written) return live;
      // The first read after the write answers and carries the field, so the confirm loop runs; every
      // confirm read after it fails.
      readsAfterWrite += 1;
      if (readsAfterWrite === 1) return live;
      if (readBack === 'throw') throw new Error('read timed out');
      return { ok: false };
    },
    placeBid: async (_id, price) => {
      wire.push(price);
      written = true;
      throw Object.assign(new Error('socket hang up'), { code: 'NETWORK' });
    },
  };
  const f = path.join(os.tmpdir(), `uncertain-failed-readback-${process.pid}-${files.length}.json`);
  files.push(f, f + '.tmp');
  const events = [];
  const engine = new BidEngine(adapter, new DurableScheduler(f), {
    config: { openAtMs: 2 * 60 * 60 * 1000, floorWindowMs: 2_500, minInterFireMs: 0 },
    live: true, onEvent: (e) => events.push(e), log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const m = engine.arm({ id: `UFR${files.length}`, lane: { origin: 'Khopoli', destination: 'Gajsinghpur' },
    equipment: 'Trailer 40', units: 1, companyName: 'Renewsys', closesAt: Date.now() + REMAINING_MS,
    startsAt: Date.now() - 1_000, status: 'live', softClose: false }, { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  try {
    await engine._maybeBid(m, live);
    const placed = events.filter((e) => e.type === 'bid_placed');
    return { wire, landed: m.landedBids, placed };
  } finally { engine.kill('done'); }
}

(async () => {
  for (const [n, shape] of [[1, 'throw'], [2, 'ok:false']]) {
    const r = await run(shape === 'throw' ? 'throw' : 'notok');
    assert.strictEqual(r.wire.length, 1, `setup (${shape}): expected one write, got ${r.wire.length}`);
    assert.strictEqual(r.landed, 1, `read-backs that ${shape === 'throw' ? 'threw' : 'came back ok:false'} disproved the write: landedBids ${r.landed}`);
    assert.ok(r.placed.length === 1 && r.placed[0].unconfirmed === true,
      `the write was not recorded as unconfirmed: ${JSON.stringify(r.placed)}`);
    ok(n, `read-backs that ${shape === 'throw' ? 'throw' : 'return ok:false'} leave the write booked, unconfirmed`);
  }
  console.log(`\n${pass}/2 checks passed`);
})().catch((e) => { console.log(`FAIL: ${e.message}`); process.exit(1); });
