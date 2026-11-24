'use strict';
/**
 * L3 SOFT-CLOSE gating, SHADOW mode, and intake admission (design D8 / G6).
 *
 *  A. per-customer strategy resolution (engine): default OFF; opt-in shipper -> shadow|live.
 *  B. SHADOW mode (_maybeBid): would-have-done decisions recorded, ZERO wire writes on soft loads.
 *  C. discovery intake admission: a VERIFIED soft load is admitted ONLY for an opted-in shipper; a
 *     disabled flag, an un-allowlisted shipper, or an unverified close model all fail closed.
 *  D. ConfigStore soft-close block: defaults, partial-merge, and fail-closed validation.
 *
 *   node scripts/test-softclose-config-intake.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { DiscoveryPoller } = require('../src/discovery/discovery');
const { defaultsFrom, validate, merge } = require('../src/admin/configStore');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `sc-cfg-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

function mkEngine(softClose, onEvent) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('SHADOW/OFF LEAK: placeBid must never be called'); },
  };
  return new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, rungs: 6, minInterFireMs: 0 },
    softClose, onEvent: onEvent || (() => {}),
  });
}
const armMeta = (companyName) => ({ id: '1', lane: { origin: 'A', destination: 'B' }, units: 1, companyName, closesAt: Date.now() + 600_000 });

(async () => {
  // ================= A. per-customer strategy resolution (default OFF) =================
  {
    // master gate OFF -> off for everyone, even a named shipper
    const off = mkEngine({ enabled: false, shippers: ['Havells'], mode: 'live' });
    assert.strictEqual(off._resolveSoftStrategy({ companyName: 'Havells' }), 'off', 'master OFF -> off');

    // enabled but empty allowlist -> off (opt-in, never blanket)
    const empty = mkEngine({ enabled: true, shippers: [], mode: 'shadow' });
    assert.strictEqual(empty._resolveSoftStrategy({ companyName: 'Havells' }), 'off', 'empty allowlist -> off');

    // enabled + allowlisted shipper -> the configured mode; a different shipper stays off
    const shadow = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'shadow' });
    assert.strictEqual(shadow._resolveSoftStrategy({ companyName: 'Havells India Ltd' }), 'shadow', 'allowlisted shipper -> shadow (word-boundary match)');
    assert.strictEqual(shadow._resolveSoftStrategy({ companyName: 'Syngenta' }), 'off', 'un-allowlisted shipper -> off');

    const live = mkEngine({ enabled: true, shippers: ['Rajratan'], mode: 'live' });
    assert.strictEqual(live._resolveSoftStrategy({ companyName: 'Rajratan Wire' }), 'live', 'mode live honored for an allowlisted shipper');

    // resolution is snapshotted at arm onto the monitor
    const m = shadow.arm(armMeta('Havells'), { marketRate: 100_000, costFloor: 70_000 });
    if (m.timer) clearTimeout(m.timer);
    assert.strictEqual(m.softStrategy, 'shadow', 'arm() snapshots the resolved strategy onto the monitor');
    ok('A per-customer gating: default OFF; opt-in shipper resolves to its shadow|live mode; others off');
  }

  // ================= B. SHADOW mode: would-have-done recorded, ZERO wire writes =================
  {
    const events = [];
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'shadow', reserve: 1 }, (e) => events.push(e));
    const m = eng.arm(armMeta('Havells'), { marketRate: 100_000, costFloor: 70_000 });
    if (m.timer) clearTimeout(m.timer);
    m.closeModel = 'soft';
    m.extendCap = 0; // effectively hard so a final-window snipe is eligible in shadow too

    const state = (remaining, myRank) => ({ closesInMs: remaining, myRank, minDecrement: 100, standingL1Price: null, measuredRttMs: 50 });
    // establish (would-bid rung 0). placeBid MUST NOT be called (it throws if it is). Soft establishes
    // LATE now (LM#5): with no trigger window surfaced here the establish mark is the openAtMs mark
    // (25s), so drive remaining inside it - the OLD immediate-at-any-remaining soft establish is gone.
    await eng._maybeBid(m, state(20_000, null));
    assert.strictEqual(m.currentRungIndex, 0, 'shadow advanced the rung as if the establish bid landed');
    assert.strictEqual(m.bidInProgress, false, 'shadow never entered the write path');
    // a would-have-fired final-window snipe is recorded with wouldSnipe true
    await eng._maybeBid(m, state(2_000, 2));
    const shadows = events.filter((e) => e.type === 'shadow_decision');
    assert.ok(shadows.length >= 2, 'shadow_decision recorded for each would-have-done bid');
    assert.ok(shadows.some((s) => s.wouldSnipe === true), 'the final-window floor snipe is recorded as a would-have-done snipe');
    assert.ok(events.every((e) => e.type !== 'bid_placed'), 'NO real bid was placed in shadow mode');
    ok('B shadow mode records would-have-done decisions (incl. the snipe) and places ZERO real bids');
  }

  // ================= C. discovery intake admission (fail-closed) =================
  {
    const mkPoller = (softClose) => new DiscoveryPoller({
      config: { allowlist: { hardCloseOnly: true, shippers: [], lanes: [] }, softClose },
    });
    const softLoad = { companyName: 'Havells India', softClose: true, closeModelKnown: true, lane: { origin: 'A', destination: 'B' } };
    const hardLoad = { companyName: 'Havells India', softClose: false, closeModelKnown: true, lane: { origin: 'A', destination: 'B' } };
    const unverified = { companyName: 'Havells India', softClose: true, closeModelKnown: false, lane: { origin: 'A', destination: 'B' } };

    // disabled -> a verified soft load stays excluded (byte-identical to today)
    assert.strictEqual(mkPoller({ enabled: false, shippers: ['Havells'] }).matchesAllowlist(softLoad), false, 'disabled: soft load excluded');
    // enabled + shipper opted in -> admitted
    assert.strictEqual(mkPoller({ enabled: true, shippers: ['Havells'] }).matchesAllowlist(softLoad), true, 'enabled + opted-in shipper: soft load admitted');
    // enabled but shipper not on the list -> excluded
    assert.strictEqual(mkPoller({ enabled: true, shippers: ['Rajratan'] }).matchesAllowlist(softLoad), false, 'enabled but un-allowlisted shipper: excluded');
    // enabled + opted in, but close model UNVERIFIED -> excluded (F8, strictest guard)
    assert.strictEqual(mkPoller({ enabled: true, shippers: ['Havells'] }).matchesAllowlist(unverified), false, 'unverified close model: excluded even for an opted-in shipper');
    // a hard-close load that the HARD allowlist admits stays in scope regardless of soft config -
    // turning soft-close ON never excludes a hard load hard-scope already admits. Uses a NON-empty
    // hard allowlist on purpose: post-#34 an empty hard allowlist fail-closes hard loads too (the
    // flood guard), so a hard load's scope must come from a real hard-allowlist entry, not the
    // removed match-all default.
    assert.strictEqual(
      new DiscoveryPoller({ config: { allowlist: { hardCloseOnly: true, shippers: ['Havells'], lanes: [] },
        softClose: { enabled: true, shippers: ['Havells'] } } }).matchesAllowlist(hardLoad), true,
      'hard-close load in the hard allowlist: in scope regardless of soft config');
    // no softClose config at all -> matchesAllowlist byte-identical to today (soft excluded)
    assert.strictEqual(new DiscoveryPoller({ config: { allowlist: { hardCloseOnly: true, shippers: [], lanes: [] } } }).matchesAllowlist(softLoad), false, 'no soft config -> soft excluded (unchanged)');
    ok('C intake admission: verified soft load admitted only for an opted-in shipper; disabled/un-allowlisted/unverified all fail closed');
  }

  // ================= D. ConfigStore soft-close block: defaults, merge, fail-closed validate =================
  {
    const base = {
      marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3,
      allowlist: { shippers: [], lanes: [], hardCloseOnly: true },
      discoveryIntervalMs: 30000, priceDeadlineLeadMs: 90000, reminderLeadMs: 60000, notifyMode: 'dashboard',
      softClose: { enabled: false, shippers: ['Havells'], mode: 'shadow', reserve: 1 },
    };
    const defaults = defaultsFrom(base);
    assert.strictEqual(defaults.softClose.enabled, false, 'defaultsFrom carries softClose.enabled (default off)');
    assert.strictEqual(defaults.softClose.mode, 'shadow', 'defaultsFrom carries softClose.mode');
    assert.deepStrictEqual(defaults.softClose.shippers, ['Havells'], 'defaultsFrom carries softClose.shippers');

    // partial merge: toggling enabled preserves the other soft knobs
    const merged = merge(defaults, { softClose: { enabled: true } });
    assert.strictEqual(merged.softClose.enabled, true, 'partial merge toggles enabled');
    assert.strictEqual(merged.softClose.mode, 'shadow', 'partial merge preserves mode');

    // validate accepts an in-bounds block and normalizes it
    const good = validate(merge(defaults, { softClose: { enabled: true, mode: 'live', reserve: 2 } }));
    assert.strictEqual(good.softClose.mode, 'live', 'valid live mode accepted');
    assert.strictEqual(good.softClose.reserve, 2, 'reserve normalized');
    // the trigger window is a per-load fact, not a config knob - validate neither requires nor emits it.
    assert.strictEqual(good.softClose.triggerWindowMs, undefined, 'no triggerWindowMs knob on the validated block');

    const badMode = () => { try { validate(merge(defaults, { softClose: { mode: 'unattended' } })); return null; } catch (e) { return e.code; } };
    assert.strictEqual(badMode(), 'BAD_INPUT', 'an unknown mode is rejected (never coerced to live)');
    const badReserve = () => { try { validate(merge(defaults, { softClose: { reserve: -1 } })); return null; } catch (e) { return e.code; } };
    assert.strictEqual(badReserve(), 'BAD_INPUT', 'a negative reserve is rejected');
    ok('D ConfigStore soft-close block: defaults + partial-merge preserved; unknown mode / negative reserve fail closed; no trigger-window knob');
  }

  // ===== E. per-load trigger window flows into shadow telemetry (E2e), fail-closed on absent =====
  // The trigger window is NOT a money-path decision input (the defend is reserve-gated the same inside
  // or outside it). Its one honest consumer is the R0 shadow record: per would-have-done decision, the
  // per-load window (Shriji = 200000, per-branch) and whether the decision lands inside it, so an
  // operator can validate the causal extension hypothesis. Absent field -> null (never a guessed window).
  {
    const events = [];
    const eng = mkEngine({ enabled: true, shippers: ['Shriji'], mode: 'shadow', reserve: 1 }, (e) => events.push(e));
    const m = eng.arm(armMeta('Shriji Polymers'), { marketRate: 100_000, costFloor: 70_000 });
    if (m.timer) clearTimeout(m.timer);
    m.closeModel = 'soft';
    // Surface the per-load window through the real writer. _surfaceTriggerWindow is what _tick calls
    // on every successful read; it used to live inside _observeExtension, which returns early for a
    // non-allowlisted soft load and so never wrote the field for that class (CW-209 r3).
    eng._observeExtension(m, { closesAtMs: m.believedCloseAt, extendMs: 180_000, extendCount: 1, triggerWindowMs: 200_000 });
    eng._surfaceTriggerWindow(m, { triggerWindowMs: 200_000 });
    assert.strictEqual(m.triggerWindowMs, 200_000, 'Shriji per-load trigger window surfaced onto the monitor');

    const st = (remaining, myRank) => ({ closesInMs: remaining, myRank, minDecrement: 100, standingL1Price: null, measuredRttMs: 50 });
    // Soft now establishes ~establishLeadMs (40s) before the 200s window, i.e. at remaining <= 240s, so
    // the establish decision is driven at 230s: still OUTSIDE the window (230s > 200s) for the telemetry
    // assertion below, but inside the establish mark so the shadow establish actually fires (LM#5).
    await eng._maybeBid(m, st(230_000, null));           // establish, remaining 230s > 200s window -> OUTSIDE
    await eng._maybeBid(m, st(150_000, 2));              // defend, remaining 150s <= 200s window -> INSIDE
    const shadows = events.filter((e) => e.type === 'shadow_decision');
    assert.ok(shadows.length >= 2, 'shadow decisions recorded');
    assert.strictEqual(shadows[0].triggerWindowMs, 200_000, 'shadow records the per-load trigger window');
    assert.strictEqual(shadows[0].insideTriggerWindow, false, 'a decision at 500s (> 200s window) is OUTSIDE');
    assert.strictEqual(shadows[1].insideTriggerWindow, true, 'a decision at 150s (<= 200s window) is INSIDE');

    // fail-closed: a soft load whose window SP never surfaced -> null window, insideTriggerWindow null.
    const eng2 = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'shadow', reserve: 1 }, (e) => events.push(e));
    const m2 = eng2.arm(armMeta('Havells'), { marketRate: 100_000, costFloor: 70_000 });
    if (m2.timer) clearTimeout(m2.timer);
    m2.closeModel = 'soft'; // no triggerWindowMs ever surfaced (monitor.triggerWindowMs stays null)
    const evLen = events.length;
    // No window surfaced -> the soft establish mark is the openAtMs mark (25s), so drive remaining
    // inside it for the establish to fire (LM#5); the window telemetry is still null either way.
    await eng2._maybeBid(m2, st(20_000, null));
    const shadow2 = events.slice(evLen).find((e) => e.type === 'shadow_decision');
    assert.strictEqual(shadow2.triggerWindowMs, null, 'absent window -> null (never a guessed value)');
    assert.strictEqual(shadow2.insideTriggerWindow, null, 'absent window -> insideTriggerWindow null (fail closed)');
    ok('E per-load trigger window feeds shadow telemetry (inside/outside recorded); absent field fails closed to null');
  }

  cleanup();
  console.log(`\n${pass}/5 checks passed`);
  process.exit(0);
})().catch((e) => { cleanup(); console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
