'use strict';
/**
 * Guards inside _observeExtension's softStrategy 'off' branch (T7 E3 repair). An 'off' soft load
 * (every GoComet enquiry, non-allowlisted SuperProcure soft loads) tracks the published close but
 * runs no soft endgame. Each check pins one guard of that branch:
 *
 *   1. control: a normal 299s round on an 'off' load is adopted and persisted (harness is live).
 *   2-3. plausibility bound: a year-2100 close is never believed, so the retire bound still fires.
 *        Check 3 is the SuperProcure-shaped placeholder (extendCount published, extendMs 180000 / null).
 *   4-5. no round counting: extendsObserved 0, extendCap null, no extension_observed or
 *        extend_cap_exceeded, while the belief did advance.
 *   6. finalized gate: a frame read while the load finalized leaves the belief and the closed
 *      intent's closesAt alone. Reached through _tick: _tick tests finalized only before the read.
 *   7. half-increment floor: a +5s wobble is not adopted.
 *   8. floor boundary: a jump of exactly half the increment IS adopted.
 *   9. published-zero increment: no advance when extendMs is 0.
 *  10. seed-if-null: a load armed with no close takes its first plausible published close, in
 *      memory only (the seed is not persisted).
 *
 * Frames reach the engine through _tick via a fake adapter. Offline and deterministic: stubbed
 * clock, temp-file DurableScheduler under os.tmpdir(), no network, no sleeps. Zero bid attempts.
 *
 *   node scripts/test-off-soft-belief-guards.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine, DEFAULTS } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const EXPECTED_CHECKS = 10;
const GC_EXTEND_MS = 299_000;
const SP_EXTEND_MS = 180_000;
const BOUND = DEFAULTS.unreadableRetireMs;
const Y2100 = Date.UTC(2100, 0, 1);

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const CLEAN = [];
let seq = 0;
const tmp = () => {
  const f = path.join(os.tmpdir(), `off-soft-guards-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  return f;
};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
let bidAttempts = 0;

function rig() {
  const ctrl = { dark: false, frame: null, beforeRead: null };
  const events = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 500, allowsTieRate: false,
      revisionLimit: 3, closeModel: 'soft', reactiveClose: true, snipeBudgetMs: 3000 }),
    async getAuctionState() {
      if (ctrl.beforeRead) { const h = ctrl.beforeRead; ctrl.beforeRead = null; await h(); }
      if (ctrl.dark) return { ok: false, error: 'portal dark' };
      return ctrl.frame ? { ...ctrl.frame } : { ok: false, error: 'no frame' };
    },
    async placeBid() { bidAttempts += 1; return { accepted: false, error: 'offline test adapter' }; },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 15_000, floorWindowMs: 2_500, minInterFireMs: 0, cadenceJitterMs: 0, openJitterMs: 0 },
    softClose: { enabled: true, shippers: ['Allowlisted'], mode: 'live', reserve: 1 },
    onEvent: (e) => events.push(e),
    log: quiet,
  });
  const arm = (id, closesAt, platformKey = 'gocomet') => {
    vnow = closesAt != null ? closesAt - 600_000 : REAL_NOW();
    const m = eng.arm({
      id, lane: { origin: 'Bhiwandi', destination: 'Hosur' }, equipment: '32ft SXL', units: 1,
      quoteType: 'FTL', companyName: 'Unlisted Shipper', closesAt, platformKey,
      rules: { revisionLimit: 3, minDecrement: 500 },
    }, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    if (m.softStrategy !== 'off') throw new Error(`HARNESS: resolved softStrategy '${m.softStrategy}', expected 'off'`);
    return m;
  };
  const tick = async (m) => {
    await eng._tick(m);
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  };
  const frame = (closesAtMs, extendMs = GC_EXTEND_MS, extendCount = null) => ({ ok: true, status: 'live',
    closeModel: 'soft', closesAtMs, closesInMs: closesAtMs - Date.now(), extendMs, extendCount,
    myRank: null, totalBidders: null, standingL1Price: null, measuredRttMs: 20 });
  const push = async (m, f) => { ctrl.frame = f; await tick(m); };
  const durable = (id) => {
    const it = eng.scheduler.get(id);
    if (!it) throw new Error(`HARNESS: no durable intent for ${id}`);
    return it.closesAt;
  };
  const ofKind = (id, pred) => events.filter((e) => e.auctionId === id && pred(e));
  const done = () => { try { eng.kill(); } catch (_) {} };
  return { eng, ctrl, events, arm, tick, frame, push, durable, ofKind, done };
}

const results = [];
async function check(n, name, kind, fn) {
  let failure = null;
  const bidsBefore = bidAttempts;
  try {
    failure = await fn();
  } catch (e) {
    failure = `threw: ${e && e.stack ? e.stack : e}`;
  }
  const bids = bidAttempts - bidsBefore;
  results.push({ n, name, kind, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${n}. ${name}${kind === 'mechanism' ? '' : ` [${kind}]`}`
    + (bids ? ` (${bids} bid attempt(s))` : ''));
  if (failure) console.log(`        ${failure}`);
}

// Belief and durable closesAt must equal `want`; returns the mismatches.
const expectClose = (r, m, want) => {
  const bad = [];
  if (m.believedCloseAt !== want) bad.push(`believedCloseAt ${m.believedCloseAt}, expected ${want}`);
  const d = r.durable(m.auctionId);
  if (d !== want) bad.push(`durable closesAt ${d}, expected ${want}`);
  return bad;
};

async function main() {
  await check(1, 'control_off_round_adopted_and_persisted', 'control', async () => {
    const r = rig();
    try {
      const posted = REAL_NOW() + 600_000;
      const m = r.arm('OFF-CTL', posted);
      vnow = posted;
      await r.push(m, r.frame(posted + GC_EXTEND_MS));
      const bad = expectClose(r, m, posted + GC_EXTEND_MS);
      return bad.length ? `HARNESS DEAD: one published 299s round on an 'off' load: ${bad.join('; ')}` : null;
    } finally { r.done(); }
  });

  // Placeholder frame while live, then a failed read BOUND + 60s past the posted close.
  const placeholderThenDark = async (r, m, posted, placeholderFrame) => {
    vnow = posted - 300_000;
    await r.push(m, placeholderFrame());
    const bad = [];
    if (m.believedCloseAt !== posted) bad.push(`believedCloseAt ${m.believedCloseAt} after a year-2100 frame, expected ${posted}`);
    vnow = posted + BOUND + 60_000;
    r.ctrl.dark = true;
    await r.tick(m);
    r.ctrl.dark = false;
    if (m.finalized !== true) bad.push(`not retired on a failed read ${BOUND + 60_000} ms past the posted close`);
    if (!r.ofKind(m.auctionId, (e) => e.kind === 'unreadable_past_close_retired').length) {
      bad.push('no unreadable_past_close_retired');
    }
    return bad;
  };

  await check(2, 'year_2100_close_not_believed_gocomet', 'mechanism', async () => {
    const r = rig();
    try {
      const posted = REAL_NOW();
      const m = r.arm('OFF-GC-2100', posted);
      const bad = await placeholderThenDark(r, m, posted, () => r.frame(Y2100));
      return bad.length ? `plausibility bound: ${bad.join('; ')}` : null;
    } finally { r.done(); }
  });

  await check(3, 'year_2100_close_not_believed_superprocure', 'mechanism', async () => {
    const bad = [];
    for (const extendMs of [SP_EXTEND_MS, null]) {
      const r = rig();
      try {
        const posted = REAL_NOW();
        const m = r.arm('OFF-SP-2100', posted, 'superprocure');
        const b = await placeholderThenDark(r, m, posted, () => r.frame(Y2100, extendMs, 5));
        for (const x of b) bad.push(`extendMs ${extendMs}: ${x}`);
      } finally { r.done(); }
    }
    return bad.length ? `plausibility bound: ${bad.join('; ')}` : null;
  });

  const noCounting = (r, m, want) => {
    const id = m.auctionId;
    const bad = [];
    if (m.believedCloseAt !== want) bad.push(`believedCloseAt ${m.believedCloseAt}, expected ${want} (belief must still track)`);
    if (m.extendsObserved !== 0) bad.push(`extendsObserved ${m.extendsObserved}, expected 0`);
    if (m.extendCap !== null) bad.push(`extendCap ${m.extendCap}, expected null`);
    const ext = r.ofKind(id, (e) => e.type === 'extension_observed').length;
    if (ext) bad.push(`${ext} extension_observed event(s), expected 0`);
    const cap = r.ofKind(id, (e) => e.kind === 'extend_cap_exceeded').length;
    if (cap) bad.push(`${cap} extend_cap_exceeded alert(s), expected 0`);
    return bad;
  };

  const rounds = async (r, m, posted, n, extendMs, extendCount) => {
    let close = posted;
    for (let i = 0; i < n; i += 1) {
      vnow = close;
      close += extendMs;
      await r.push(m, r.frame(close, extendMs, extendCount));
    }
    return close;
  };

  await check(4, 'no_rounds_counted_gocomet', 'mechanism', async () => {
    const r = rig();
    try {
      const posted = REAL_NOW() + 600_000;
      const m = r.arm('OFF-GC-COUNT', posted);
      const live = await rounds(r, m, posted, 3, GC_EXTEND_MS, null);
      const bad = noCounting(r, m, live);
      return bad.length ? `3 published 299s rounds on an 'off' load: ${bad.join('; ')}` : null;
    } finally { r.done(); }
  });

  await check(5, 'no_rounds_counted_superprocure', 'mechanism', async () => {
    const r = rig();
    try {
      const posted = REAL_NOW() + 600_000;
      const m = r.arm('OFF-SP-COUNT', posted, 'superprocure');
      const live = await rounds(r, m, posted, 6, SP_EXTEND_MS, 5);
      const bad = noCounting(r, m, live);
      return bad.length ? `6 published 180s rounds (extendCount 5) on an 'off' load: ${bad.join('; ')}` : null;
    } finally { r.done(); }
  });

  await check(6, 'frame_read_across_finalize_not_adopted', 'mechanism', async () => {
    const r = rig();
    try {
      const posted = REAL_NOW();
      const m = r.arm('OFF-FINAL', posted);
      vnow = posted;
      const closed = { ...r.frame(posted), status: 'closed', myRank: 2, totalBidders: 4 };
      const late = r.frame(posted + GC_EXTEND_MS);
      r.ctrl.frame = closed;
      r.ctrl.beforeRead = async () => { await r.eng._finalize(m, closed); r.ctrl.frame = late; };
      await r.tick(m);
      const intent = r.eng.scheduler.get('OFF-FINAL');
      if (m.finalized !== true || !intent || intent.status !== 'closed') {
        return `HARNESS: the load did not finalize during the read (finalized=${m.finalized}, status=${intent && intent.status})`;
      }
      const bad = expectClose(r, m, posted);
      return bad.length ? `a +299s frame read while the load finalized moved the close: ${bad.join('; ')}` : null;
    } finally { r.done(); }
  });

  await check(7, 'five_second_wobble_not_adopted', 'mechanism', async () => {
    const r = rig();
    try {
      const posted = REAL_NOW() + 600_000;
      const m = r.arm('OFF-WOBBLE', posted);
      vnow = posted - 300_000;
      await r.push(m, r.frame(posted + 5_000));
      const bad = expectClose(r, m, posted);
      return bad.length ? `half-increment floor: a +5000 ms forward wobble: ${bad.join('; ')}` : null;
    } finally { r.done(); }
  });

  await check(8, 'exact_half_increment_jump_adopted', 'mechanism', async () => {
    const r = rig();
    try {
      const posted = REAL_NOW() + 600_000;
      const m = r.arm('OFF-HALF', posted);
      vnow = posted - 300_000;
      await r.push(m, r.frame(posted + GC_EXTEND_MS * 0.5));
      const bad = expectClose(r, m, posted + GC_EXTEND_MS * 0.5);
      return bad.length ? `floor boundary: a jump of exactly extendMs*0.5 (${GC_EXTEND_MS * 0.5} ms): ${bad.join('; ')}` : null;
    } finally { r.done(); }
  });

  await check(9, 'published_zero_increment_no_advance', 'mechanism', async () => {
    const r = rig();
    try {
      const posted = REAL_NOW() + 600_000;
      const m = r.arm('OFF-ZERO', posted);
      vnow = posted - 300_000;
      await r.push(m, r.frame(posted + 300_000, 0));
      const bad = expectClose(r, m, posted);
      return bad.length ? `extendMs 0, frame +300000 ms: ${bad.join('; ')}` : null;
    } finally { r.done(); }
  });

  await check(10, 'null_close_seeded_in_memory_only', 'mechanism', async () => {
    const r = rig();
    try {
      const m = r.arm('OFF-SEED', null);
      if (m.believedCloseAt !== null || r.durable('OFF-SEED') !== null) {
        return `HARNESS: armed with closesAt null but believed ${m.believedCloseAt}, durable ${r.durable('OFF-SEED')}`;
      }
      const x = vnow + 900_000;
      const bad = [];
      await r.push(m, r.frame(x, 0));
      if (m.believedCloseAt !== x) bad.push(`first frame (extendMs 0): believedCloseAt ${m.believedCloseAt}, expected ${x}`);
      vnow += 1_000;
      await r.push(m, r.frame(x, GC_EXTEND_MS));
      if (m.believedCloseAt !== x) bad.push(`second frame (extendMs ${GC_EXTEND_MS}): believedCloseAt ${m.believedCloseAt}, expected ${x}`);
      const d = r.durable('OFF-SEED');
      if (d !== null) bad.push(`durable closesAt ${d}, expected null (the seed is not a confirmed move)`);
      return bad.length ? `seed-if-null: ${bad.join('; ')}` : null;
    } finally { r.done(); }
  });
}

main().catch((e) => {
  results.push({ n: 0, name: 'harness', kind: 'control', failure: `threw: ${e && e.stack ? e.stack : e}` });
}).then(() => {
  Date.now = REAL_NOW;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }

  const isHarness = (x) => x.failure && (x.kind !== 'mechanism' || /^(HARNESS|threw:)/.test(x.failure));
  const harness = results.filter(isHarness);
  const mech = results.filter((x) => x.failure && !isHarness(x));
  if (harness.length || bidAttempts > 0 || results.length !== EXPECTED_CHECKS) {
    console.log(`\nFAIL - HARNESS: ${harness.map((x) => `${x.n}. ${x.name}`).join(', ') || 'no check'} failed, `
      + `${bidAttempts} bid attempt(s) reached the fake adapter, ${results.length} of ${EXPECTED_CHECKS} checks ran`);
    process.exit(1);
  }
  if (mech.length) {
    console.log(`\nFAIL - ${mech.length} of ${results.length} checks (${mech.map((x) => x.n).join(', ')}): `
      + "a guard in the softStrategy 'off' believed-close branch is broken");
    process.exit(1);
  }
  console.log(`\nPASS - ${results.length} checks: softStrategy 'off' believed-close guards hold`);
});
