'use strict';
/**
 * GoComet close model - the adapter-side translator that reconstructs a reactive soft close from
 * one countdown, and the adapter wiring that turns its output into ordinary engine state.
 *
 * WHAT THIS PINS:
 *   A. REHOME. The module lives under src/platform/, and its table of GoComet plant names appears
 *      in no other source file (MULTI_PLATFORM_ARCHITECTURE.md invariant 1).
 *   B. THE 240s ROWS ARE GONE. Every plant seeds at the measured 299s rounded UP. The old table's
 *      240,000 entries were a bid_close_time minute-truncation artefact, and publishing one would
 *      have sized the engine's finalize debounce BELOW one real extension step.
 *   C. MULTI-ROUND COUNTING. Two rounds inside one poll gap are two rounds, not one.
 *   D. THE HELD ZERO. An extension delivered as a countdown held at zero and then resumed is
 *      recognised even when the resulting forward move is smaller than minJumpMs - the shape a bare
 *      jump threshold drops.
 *   E. POLLING NOISE. Quantization wobble never counts and never teaches the increment.
 *   F. TERMINALITY WITHOUT bidding_closed. The zero-held rule is the sole carrier; the flag is not
 *      an input, and feeding one changes nothing.
 *   G. FAIL-SAFE UP. Learning may lengthen the published extendMs and may never shorten it.
 *   H. ADAPTER WIRING. One model per enquiry key, seeded from the load's plant, output published as
 *      state.extendMs - with the pinned 300,000 unchanged on a fresh load.
 *   I. ENGINE INTEGRATION. 22 consecutive extensions with extendMs supplied by the translator leave
 *      the monitor alive on no more than 3 bids.
 *
 *   node scripts/test-gocomet-close-model.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {
  GoCometCloseModel, resolvePlantIncrementMs, PLANT_INCREMENTS_MS, GOCOMET_INCREMENT_DEFAULT_MS,
} = require('../src/platform/gocometCloseModel');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { GoCometSim, GoCometSimAdapter, EXTEND_STEP_MS } = require('../src/sim/gocometSim');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// The runner grades by EXIT CODE only, so a file that returns early or never awaits its async work
// exits 0 having asserted nothing and reads as a silent green. The sentinel at the bottom pins the
// exact number of checks that ran.
const EXPECTED_CHECKS = 54;

const ROOT = path.resolve(__dirname, '..');

let seq = 0;
const CLEAN = [];
const tmp = () => {
  const f = path.join(os.tmpdir(), `gc-cm-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  return f;
};
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

// ---- adapter test doubles (same shapes as scripts/test-gocomet-adapter.js) ---------------------
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const makeToken = (claims) => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url(claims)}.sig`;
const validToken = () => makeToken({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' });
const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const noSleep = async () => {};

/** Walk a directory tree, yielding every .js/.ts/.tsx file path. */
function sourceFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (ent.name !== 'node_modules') sourceFiles(p, out); }
    else if (/\.(js|ts|tsx)$/.test(ent.name)) out.push(p);
  }
  return out;
}

(async () => {
  // ---- A. REHOME: the plant table is platform-scoped ------------------------------------------
  {
    const resolved = require.resolve('../src/platform/gocometCloseModel');
    ok(resolved.includes(path.join('src', 'platform')),
      'A: the module resolves under src/platform/, not src/engine/');
    ok(!fs.existsSync(path.join(ROOT, 'src', 'engine', 'gocometCloseModel.js')),
      'A: no copy survives at the src/engine/ path the lifted version used');

    // Invariant 1: no portal-specific identifier outside src/platform/. Plant names are exactly
    // that, and they are the reason this file was rehomed rather than lifted where it stood.
    const PLANT_TOKENS = ['nandigram', 'umbergaon', 'ecotech', 'greater noida'];
    const roots = [path.join(ROOT, 'src'), path.join(ROOT, 'dashboard', 'src')].filter((d) => fs.existsSync(d));
    const offenders = [];
    for (const r of roots) {
      for (const f of sourceFiles(r)) {
        const hay = fs.readFileSync(f, 'utf8').toLowerCase();
        if (PLANT_TOKENS.some((t) => hay.includes(t))) offenders.push(path.relative(ROOT, f));
      }
    }
    ok(offenders.length === 1 && offenders[0].split(path.sep).join('/') === 'src/platform/gocometCloseModel.js',
      `A: the plant-name table appears in exactly one source file, under src/platform/ (saw: ${offenders.join(', ') || 'none'})`);
  }

  // ---- B. the 240,000 rows are gone ------------------------------------------------------------
  {
    ok(PLANT_INCREMENTS_MS.every((r) => r.ms === GOCOMET_INCREMENT_DEFAULT_MS),
      'B: every plant seeds at the same measured increment - the 240s/300s split was a truncation artefact');
    ok(GOCOMET_INCREMENT_DEFAULT_MS === 300_000,
      'B: the seed is 299s rounded UP, the only rounding direction that lengthens the finalize debounce');
    ok(resolvePlantIncrementMs('Sachin GIDC, Surat') === 300_000,
      'B: a Sachin/Surat origin seeds 300,000 (it used to seed 240,000 - a 243s debounce under a 299s step)');
    ok(resolvePlantIncrementMs('Degam (Survey No. 1934, NH-48, Chikhli)') === 300_000,
      'B: a full-address origin still matches its plant');
    ok(resolvePlantIncrementMs('Somewhere Never Seen') === 300_000,
      'B: an unrecognised plant seeds at the full increment - the fail-safe-up direction');
    ok(resolvePlantIncrementMs(null) === 300_000, 'B: an absent origin seeds at the full increment');
    ok(resolvePlantIncrementMs('Tumb', [{ match: 'tumb', ms: 450_000 }]) === 450_000,
      'B: an operator override is tried before the built-in table');
    ok(resolvePlantIncrementMs('Tumb', [{ match: 'tumb', ms: 0 }]) === 300_000,
      'B: a garbage override value is skipped rather than published');
  }

  // ---- C. multi-round counting -----------------------------------------------------------------
  {
    const m = new GoCometCloseModel({});
    const T = 1_000_000;
    ok(m.observe({ closeAtMs: T + 600_000, atMs: T }).extended === false,
      'C: the first live observation adopts the close and counts nothing');

    const r1 = m.observe({ closeAtMs: T + 600_000 + 299_000, atMs: T + 10_000 });
    ok(r1.extended === true && r1.roundsCounted === 1, 'C: a single 299s step is one round');

    // Two rounds inside one poll gap. The research corpus was built by a syncer that collapsed
    // these into one event, which is why its whole distribution is a lower bound.
    const r2 = m.observe({ closeAtMs: T + 600_000 + 3 * 299_000, atMs: T + 20_000 });
    ok(r2.roundsCounted === 2 && r2.roundsObserved === 3,
      'C: a 598s jump across one poll gap counts TWO rounds, not one');
    ok(m.jumpsObserved === 2 && m.roundsObserved === 3,
      'C: jumpsObserved stays below roundsObserved when aliasing occurred');

    // The divider clamp only becomes reachable once a SHORT increment has been learned: at the
    // 300s seed, 13 rounds already exceed maxRoundJumpMs and take the re-open path instead.
    const clamp = new GoCometCloseModel({ incrementMs: 100_000 });
    clamp.observe({ closeAtMs: T + 600_000, atMs: T });
    const big = clamp.observe({ closeAtMs: T + 600_000 + 3_000_000, atMs: T + 10_000 });
    ok(big.roundsCounted === 12 && big.anomaly === 'rounds_clamped',
      'C: the multi-round divider is clamped, and the clamp is surfaced rather than swallowed');

    const reopen = new GoCometCloseModel({});
    reopen.observe({ closeAtMs: T + 600_000, atMs: T });
    const jr = reopen.observe({ closeAtMs: T + 600_000 + 3 * 86_400_000, atMs: T + 10_000 });
    ok(jr.roundsCounted === 1 && jr.anomaly === 'implausible_jump',
      'C: a 3-day slide is a shipper re-open - one round, flagged, never 800 phantom rounds');
  }

  // ---- D. THE HELD ZERO ------------------------------------------------------------------------
  // The countdown expires, is held at zero while the platform writes the new deadline, then resumes
  // only 20s beyond the expired close - a reactive close is written as (bid instant + increment),
  // not (old close + increment), so after a long hold the new deadline can land well inside
  // minJumpMs of the old one. A bare forward-jump test drops exactly this round.
  {
    const m = new GoCometCloseModel({});
    const T = 2_000_000;
    m.observe({ closeAtMs: T + 5_000, atMs: T });     // live, closing in 5s
    m.observe({ closeAtMs: null, atMs: T + 6_000 });  // expired
    const mid = m.observe({ closeAtMs: null, atMs: T + 11_000 });
    ok(mid.heldZero === false && mid.terminal === false,
      'D: 5s of zero is inside the hold threshold and is not yet evidence of anything');
    const held = m.observe({ closeAtMs: null, atMs: T + 18_000 });
    ok(held.heldZero === true && held.terminal === false,
      'D: 12s of held zero marks the deadline as having visibly passed, still short of terminal');

    const back = m.observe({ closeAtMs: T + 25_000, atMs: T + 19_000 });
    ok(back.extended === true && back.roundsCounted === 1 && back.heldZero === true,
      'D: the resumed countdown counts one round even though the close moved only 20s');
    ok(back.jumpMs === 20_000 && back.jumpMs < 30_000,
      'D: ...and the move really is under minJumpMs, so a jump threshold alone would have dropped it');
    ok(m.zeroSince === null && m.isTerminal(T + 19_000) === false,
      'D: a live countdown clears the zero run - the auction is not terminal after all');

    // The control: the SAME sub-minJump resume with a hold too short to license it stays uncounted.
    const c = new GoCometCloseModel({});
    c.observe({ closeAtMs: T + 5_000, atMs: T });
    c.observe({ closeAtMs: null, atMs: T + 6_000 });
    const small = c.observe({ closeAtMs: T + 25_000, atMs: T + 8_000 });
    ok(small.extended === false && c.roundsObserved === 0,
      'D: CONTROL - the same 20s move after only 2s of zero counts nothing, so it is the HOLD that licenses it');

    // A held zero followed by a full-size resume is still ONE round, never two.
    const f = new GoCometCloseModel({});
    f.observe({ closeAtMs: T + 5_000, atMs: T });
    f.observe({ closeAtMs: null, atMs: T + 6_000 });
    f.observe({ closeAtMs: null, atMs: T + 18_000 });
    const full = f.observe({ closeAtMs: T + 5_000 + 299_000, atMs: T + 19_000 });
    ok(full.roundsCounted === 1 && f.roundsObserved === 1,
      'D: a held zero resolved by a full 299s step is one round, not one plus one');
    ok(f.incrementConfirmed === false,
      'D: and a held-zero round never teaches the increment - its magnitude is an artefact of the hold');
  }

  // ---- E. polling noise -------------------------------------------------------------------------
  {
    const m = new GoCometCloseModel({});
    const T = 3_000_000;
    m.observe({ closeAtMs: T + 600_000, atMs: T });
    let counted = 0;
    for (let i = 1; i <= 20; i += 1) {
      const wobble = (i % 2 === 0 ? 1 : -1) * 2_000; // +/-2s second-quantization + RTT wobble
      if (m.observe({ closeAtMs: T + 600_000 + wobble, atMs: T + i * 1_000 }).extended) counted += 1;
    }
    ok(counted === 0 && m.roundsObserved === 0, 'E: 20 polls of +/-2s wobble count zero extensions');
    ok(m.incrementConfirmed === false, 'E: ...and never enter the learning sample');
    ok(m.impliedCloseAt === T + 602_000,
      'E: the belief moved FORWARD only - a backward wobble never depresses the base a real jump is measured from');

    // Above minJumpMs but outside the clean band: a real round, but no evidence about the increment.
    const b = new GoCometCloseModel({});
    b.observe({ closeAtMs: T + 600_000, atMs: T });
    b.observe({ closeAtMs: T + 600_000 + 299_000, atMs: T + 10_000 });
    const odd = b.observe({ closeAtMs: T + 600_000 + 299_000 + 45_000, atMs: T + 20_000 });
    ok(odd.extended === true && odd.roundsCounted === 1, 'E: a 45s forward move is a round');
    ok(b.incrementConfirmed === false,
      'E: ...but it sits outside the 100-400s clean band, so the increment is still the unconfirmed seed');
  }

  // ---- F. terminality without bidding_closed ----------------------------------------------------
  {
    const T = 4_000_000;
    const m = new GoCometCloseModel({});
    m.observe({ closeAtMs: T + 5_000, atMs: T });
    m.observe({ closeAtMs: null, atMs: T + 6_000 });
    ok(m.observe({ closeAtMs: null, atMs: T + 20_000 }).terminal === false,
      'F: 14s of exhausted countdown is inside the grace and is NOT terminal');
    ok(m.observe({ closeAtMs: null, atMs: T + 40_000 }).terminal === true,
      'F: 34s of exhausted countdown IS terminal - the zero-held rule alone, no close flag anywhere');
    ok(m.isTerminal(T + 40_000) === true, 'F: and isTerminal agrees when asked directly');

    // The census (44/44 responses, seven keys, bidding_closed absent from all) says the flag never
    // arrives. Feeding one anyway must not change a single answer, in either direction.
    const g = new GoCometCloseModel({});
    g.observe({ closeAtMs: T + 5_000, atMs: T, biddingClosed: true });
    g.observe({ closeAtMs: null, atMs: T + 6_000, biddingClosed: true });
    ok(g.observe({ closeAtMs: null, atMs: T + 20_000, biddingClosed: true }).terminal === false,
      'F: a bidding_closed:true alongside an exhausted countdown does NOT shortcut the grace');
    ok(g.observe({ closeAtMs: T + 300_000, atMs: T + 21_000, biddingClosed: true }).extended === true,
      'F: nor does it suppress a resumed countdown - the flag is not an input at all');

    // A re-open after the grace is a different mechanic from an anti-snipe round, and is labelled.
    const r = new GoCometCloseModel({});
    r.observe({ closeAtMs: T + 5_000, atMs: T });
    r.observe({ closeAtMs: null, atMs: T + 6_000 });
    r.observe({ closeAtMs: null, atMs: T + 50_000 });
    const re = r.observe({ closeAtMs: T + 400_000, atMs: T + 51_000 });
    ok(re.extended === true && re.anomaly === 'reopen_after_terminal',
      'F: a live countdown returning after the grace is counted but flagged as a re-open, not a round');
  }

  // ---- G. fail-safe UP: learning may lengthen extendMs and may never shorten it -----------------
  {
    const T = 5_000_000;
    const fresh = new GoCometCloseModel({});
    ok(fresh.publishedExtendMs() === 300_000, 'G: a fresh model publishes the seed');

    // A plant genuinely stepping SHORTER than the seed. incrementMs follows the evidence (it is the
    // round divider) but the published debounce does not - a debounce below one real step finalizes
    // a live auction, and finalize is terminal.
    const lo = new GoCometCloseModel({});
    lo.observe({ closeAtMs: T + 600_000, atMs: T });
    lo.observe({ closeAtMs: T + 600_000 + 150_000, atMs: T + 10_000 });
    lo.observe({ closeAtMs: T + 600_000 + 300_000, atMs: T + 20_000 });
    ok(lo.learnedIncrementMs === 150_000, 'G: the learner measured a 150s step from the clean band');
    ok(lo.publishedExtendMs() === 300_000,
      'G: ...and the published extendMs held at the seed - learning can never SHORTEN the debounce');

    const hi = new GoCometCloseModel({});
    hi.observe({ closeAtMs: T + 600_000, atMs: T });
    hi.observe({ closeAtMs: T + 600_000 + 390_000, atMs: T + 10_000 });
    hi.observe({ closeAtMs: T + 600_000 + 780_000, atMs: T + 20_000 });
    ok(hi.learnedIncrementMs === 390_000 && hi.publishedExtendMs() === 390_000,
      'G: a plant stepping LONGER than the seed lengthens the published debounce to match');
  }

  // ---- H. adapter wiring ------------------------------------------------------------------------
  {
    let t = Date.parse('2026-08-10T09:00:00Z');
    const now = () => t;
    let secs = 600;
    const fetchImpl = async (url) => {
      if (url.includes('/bidding-data')) {
        return resp(200, {
          data: {
            bid_closing_in: secs, vendor_rank: 2, total_revisions: 0, revisions_left: 3,
            current_server_time: new Date(t).toISOString(),
          },
        });
      }
      if (url.includes('/enquiries/spot')) {
        return resp(200, {
          data: {
            enquiries: [{
              key: 'K-TUMB', bid_close_timestamp: new Date(t + 600_000).toISOString(),
              origin: 'Tumb (Umbergaon)', destination: 'Hosur', mode: '32ft SXL',
              bidding_closed: false, name: 'Spot 1', client_company_name: 'Waaree Energies',
            }],
            total_page: 1,
          },
        });
      }
      return resp(404, {});
    };

    const a = new GoCometAdapter({ token: validToken(), sleep: noSleep, now, fetchImpl });
    await a.login();

    const live = await a.getAuctionState('K1');
    ok(live.extendMs === 300_000,
      'H: a fresh enquiry still publishes exactly 300,000 - the translator changes the source, not the value');
    ok(a._closeModels.has('K1'), 'H: the adapter owns one close model per enquiry key');

    t += 10_000; secs = 899;
    await a.getAuctionState('K1');
    ok(a._closeModels.get('K1').roundsObserved === 1,
      'H: the model accumulated the 299s step across two getAuctionState calls');
    ok((await a.getAuctionState('K-OTHER')).extendMs === 300_000 && a._closeModels.get('K-OTHER').roundsObserved === 0,
      'H: the state is PER-ENQUIRY - a second key starts from its own seed with no borrowed history');

    // The plant seed reaches the wire: an operator override on the Tumb rule changes what the
    // adapter publishes for a Tumb-origin enquiry, proving origin -> seed -> state.extendMs.
    const p = new GoCometAdapter({
      token: validToken(), sleep: noSleep, now, fetchImpl,
      plantIncrementOverrides: [{ match: 'tumb', ms: 450_000 }],
    });
    await p.login();
    const loads = await p.listAuctions();
    ok(loads.length === 1 && loads[0].lane.origin === 'Tumb (Umbergaon)', 'H: the enquiry maps with its plant origin');
    ok((await p.getAuctionState('K-TUMB')).extendMs === 450_000,
      'H: the plant seed reaches state.extendMs - origin -> resolvePlantIncrementMs -> the wire');
    ok((await p.getAuctionState('K-UNSEEN')).extendMs === 300_000,
      'H: an enquiry whose plant was never listed falls back to the default seed, not to the override');
  }

  // ---- I. engine integration: 22 consecutive extensions ----------------------------------------
  // The inversion, end to end and in miniature: the translator is fed the adapter's own derived
  // close, and its entire output leaves as the ordinary state.extendMs the engine already reads.
  {
    let t = Date.now();
    const sim = new GoCometSim({ clock: () => t, closesInMs: 600_000, reactiveWindowMs: 0, settleMs: 0 });
    const model = new GoCometCloseModel({});
    const adapter = new GoCometSimAdapter(sim);
    const inner = adapter.getAuctionState.bind(adapter);
    adapter.getAuctionState = async (id) => {
      const s = await inner(id);
      model.observe({ closeAtMs: s.closesAtMs, atMs: sim.now() });
      s.extendMs = model.publishedExtendMs();
      return s;
    };

    const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
      config: {
        openAtMs: 15_000, floorWindowMs: 2_500, finalizeDebounceMs: 0,
        minInterFireMs: 0, cadenceJitterMs: 0, openJitterMs: 0,
      },
      softClose: { enabled: true, shippers: ['Waaree'], mode: 'live', reserve: 1 },
      onEvent: () => {},
    });
    const m = eng.arm({
      id: 'GC-SIM-1', lane: { origin: 'Bhiwandi', destination: 'Hosur' }, equipment: '32ft SXL',
      units: 1, quoteType: 'FTL', companyName: 'Waaree Energies', closesAt: sim.closesAt,
      rules: { revisionLimit: 3, minDecrement: sim.minDecrement },
    }, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
    const detach = () => { if (m.timer) { clearTimeout(m.timer); m.timer = null; } };
    detach();
    const advanceTo = (ms) => { t = sim.closesAt - ms; };
    const tick = async () => { await eng._tick(m); detach(); };

    let minPublished = Infinity;
    for (let round = 1; round <= 22; round += 1) {
      advanceTo(12_000); await tick();
      if (round === 1) sim.rivalBid('RIVAL-1', 76_000);
      advanceTo(6_000); await tick();
      if (round === 1) sim.rivalBid('RIVAL-1', 74_800);
      advanceTo(2_000); await tick();
      minPublished = Math.min(minPublished, model.publishedExtendMs());
      sim.extend('platform');
    }
    advanceTo(12_000); await tick();

    ok(m.finalized === false, 'I: the monitor is still alive after 22 translator-fed extensions');
    ok(model.roundsObserved === 22, 'I: the translator counted all 22 rounds from the countdown alone');
    ok(sim.ourBids().length <= 3 && sim.ourBids().length === 3,
      'I: exactly three bids across 22 rounds - GoComet caps revisions at 3 per vendor per enquiry');
    ok(m.revisionsLeft === 0, 'I: the revision budget is exhausted and does not reset on an extension');
    ok(model.learnedIncrementMs === EXTEND_STEP_MS,
      'I: the learner measured the true 299s step off the live feed');
    ok(minPublished === 300_000,
      'I: ...and the published extendMs never dropped to it - 299,000 is the measurement, 300,000 is the guard');
    ok(m.extendsObserved === 22,
      'I: the ENGINE still owns round counting for strategy - the translator did not become a second one');
  }

  // ---- completion sentinel ----------------------------------------------------------------------
  assert.strictEqual(fail, 0, `${fail} GoComet close-model checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - the file exited early or a block was skipped`);
  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { cleanup(); console.error('test crashed:', e && e.stack || e); process.exit(1); });
