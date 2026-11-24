'use strict';
/**
 * THE RESTORE PATH TAKES A PERSISTED CLOSE RAW - past the engine's own plausibility bound.
 *
 * Regression target: T2 D1 of the 2026-09-16 bid-command hunt (verify files
 * 2026-09-16_bidcmd-T2-verify-boundary2 / -boundary4 / -inv3, all upheld_confirmed 3/3).
 *
 * bidEngine.js declares MAX_PLAUSIBLE_CLOSE_SKEW_MS = 30 days and wraps it in plausibleCloseAt,
 * whose own docstring names both failure shapes: "Number(null) is a finite 0 that reads as a close
 * on 1 Jan 1970 ... and SuperProcure's year-2100 placeholder is a perfectly valid number that reads
 * as a 74-year runway the engine will never race against. Both have cost real bids." That screen is
 * applied to the LIVE read and to none of the restore reads: _intentToArm carries `closesAt:
 * it.closesAt` verbatim, arm() computes the countdown as `Math.max(0, meta.closesAt - Date.now())`
 * and stores `believedCloseAt` from the same raw field. So one durable record produces two faults:
 *
 *   - the year-2100 placeholder restores as a real deadline - a 73-year countdown, counted in the
 *     restart banner as a resumed live auction on every boot, and persisted as the load's believed
 *     close for the finalize path to read back;
 *   - an absent / null / empty close reaches that Math.max, and Math.max(0, NaN) is NaN, which does
 *     not throw: it LOSES both `>` comparisons in _cadence and resolves to the 200 ms snipe poll for
 *     the life of the process - five reads per second per load against a shared vendor account.
 *
 * WHAT THIS FILE ENFORCES is OWNER RULING 1 (2026-09-20 wave execution plan): "Unknown or
 * implausible close on restore = HOLD the load and TELL THE DESK. Never bid it, never retire it as
 * unknown." So: no monitor, no bid, no retirement, and a desk-visible alert per held load.
 *
 * THE RULING BINDS TWO RESTORE DOORS, NOT ONE. Check 9 covers the second: the operator kill-switch
 * cycle, where resume() re-plans a scheduled intent's wake directly and never passes through
 * retirePastClose() - so a hold implemented only in the retirement sweep is walked straight back
 * through this door, and the validator observed exactly that (armed=true closesInMs=NaN
 * believedCloseAt=null cadence=200ms) against a working ruling-1 hold on the rehydrate door.
 *
 * EXPECTED TO STAY RED UNDER THE NARROW ONE-LINE SCREEN. Both verifiers recorded that putting
 * plausibleCloseAt on _intentToArm's closesAt does not satisfy the ruling - the load still ARMS,
 * at closesInMs 0, and still resolves to the 200 ms cadence. The flip proves the bypass is the
 * cause; it is not the resolution. Checks 3, 5, 6, 8 and 9 will remain red under it by design.
 *
 * WHAT MUST NOT MOVE: REAL-2H and EDGE-30D (just inside the 30-day bound) restore and arm exactly
 * as today - armed, real countdown, believedCloseAt equal to the stored close, no hold alert, and
 * no hot cadence. A screen that stops a believable close from resuming is a worse defect than the
 * one being repaired.
 *
 * The fixture starts from the durable-intent state rehydrate actually consumes: intake refuses a
 * placeholder close (assertRealClose -> NO_VALID_CLOSE), and getAuctionState's JSDoc does not list
 * closesAtMs at all, so an adapter that omits it is conforming - both shapes reach disk without
 * anything upstream misbehaving.
 *
 * Offline and deterministic: fake adapter, no network, temp intents files under os.tmpdir, engine
 * RNG pinned. Checks 1-8 run with no sleeps at all; check 9 waits on the engine's OWN wake timer,
 * which is the unit under test on that door, and settles on whichever outcome arrives - an armed
 * monitor or a held load's alert - so neither world burns a fixed delay.
 *
 *   node scripts/test-restore-close-plausibility-hold.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const T0 = Date.now();
const DAY = 86_400_000;
const MAX_SKEW = 30 * DAY;
const PLACEHOLDER = Date.UTC(2100, 0, 1);

const FILES = [];
const ENGINES = [];
const tmpFile = (tag) => {
  const f = path.join(os.tmpdir(), `restore-close-hold-${tag}-${process.pid}.json`);
  FILES.push(f);
  return f;
};
const cleanup = () => {
  for (const e of ENGINES) { try { e.kill('done'); } catch (_) {} }
  for (const f of FILES) { try { fs.unlinkSync(f); } catch (_) {} }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const adapter = {
  writeEnabled: false,
  capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
  ensureSession: async () => ({}),
  getAuctionState: async () => ({ ok: false, error: 'harness: no platform read' }),
  placeBid: async () => { throw new Error('placeBid reached - ruling 1 says a held load is never bid'); },
};
const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

const base = (id) => ({
  auctionId: id, status: 'bidding',
  lane: { origin: 'Bhiwandi', destination: 'Hosur' }, equipment: '32ft SXL', units: 1,
  companyName: 'Havells India', branchName: 'Alwar', platformKey: 'superprocure',
  rules: { minDecrement: 100, revisionLimit: 3, pricingMode: 'flat', rateType: 'per_truck' },
  cost: 50_000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 5,
  firedRungs: [], everBid: false, landedBids: 0, finalRank: null, won: null,
  createdAt: T0 - 3_600_000,
});
const withClose = (id, closesAt) => Object.assign(base(id), { closesAt });

// ABSENT is written by omitting the key: JSON.stringify drops an undefined value, which is exactly
// how "the platform never sent it" reaches disk.
const INTENTS = [
  withClose('Y2100', PLACEHOLDER),
  base('ABSENT'),
  withClose('NULL-CLOSE', null),
  withClose('EMPTY-CLOSE', ''),
  withClose('REAL-2H', T0 + 2 * 3_600_000),
  withClose('EDGE-30D', T0 + MAX_SKEW - 60_000),
];
const HELD = ['Y2100', 'ABSENT', 'NULL-CLOSE', 'EMPTY-CLOSE'];
const CONTROLS = ['REAL-2H', 'EDGE-30D'];
const rawClose = (id) => (INTENTS.find((i) => i.auctionId === id) || {}).closesAt;

const FILE = tmpFile('rehydrate');
fs.writeFileSync(FILE, JSON.stringify({ savedAt: T0, intents: INTENTS }), 'utf8');

const events = [];
const eng = new BidEngine(adapter, new DurableScheduler(FILE), {
  onEvent: (e) => events.push(e), log: SILENT, rand: () => 0.5,
});
eng.log = SILENT;
ENGINES.push(eng);

const mon = (id) => eng.monitors.get(id) || {};
const shown = (id) => `armed=${eng.monitors.has(id)} closesInMs=${String(mon(id).closesInMs)}`
  + ` believedCloseAt=${JSON.stringify(mon(id).believedCloseAt)}`;

(async () => {
  // --------------------------------------------- 1. precondition: the fixture is what reaches disk
  {
    const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8')).intents;
    const byId = Object.fromEntries(onDisk.map((i) => [i.auctionId, i]));
    assert.strictEqual(onDisk.length, 6, 'fixture: six intents must reach disk');
    assert.ok(!('closesAt' in byId['ABSENT']), 'fixture: the ABSENT shape must have no closesAt key after the JSON round-trip');
    assert.strictEqual(byId['NULL-CLOSE'].closesAt, null, 'fixture: null survives JSON verbatim');
    assert.strictEqual(byId['EMPTY-CLOSE'].closesAt, '', 'fixture: the empty string survives JSON verbatim');
    assert.strictEqual(byId['Y2100'].closesAt, PLACEHOLDER, 'fixture: the year-2100 placeholder survives JSON verbatim');
    assert.strictEqual(eng.scheduler.activeIntents().length, 6, 'fixture: all six load as active intents before rehydrate');
    ok('the six-intent fixture round-trips to disk as written (four implausible shapes, two controls)');
  }

  const resumed = await eng.rehydrate();
  const banner = events.find((e) => e.type === 'alert' && e.kind === 'restart_with_live_auctions');
  const alertIds = new Set(events.filter((e) => e.type === 'alert' && e.auctionId).map((e) => e.auctionId));

  // --------------------------------------------- 2. CONTROL: a believable close still resumes
  {
    for (const id of CONTROLS) {
      assert.ok(eng.monitors.has(id), `control broken: ${id} must still arm on restore - ${shown(id)}`);
      const expected = rawClose(id) - Date.now();
      assert.ok(Math.abs(mon(id).closesInMs - expected) < 5_000,
        `control broken: ${id} countdown ${mon(id).closesInMs} is not the real remaining ${expected}`);
      assert.strictEqual(mon(id).believedCloseAt, rawClose(id),
        `control broken: ${id} must keep the stored close as its believed close`);
      const c = eng._cadence(mon(id).closesInMs, mon(id));
      assert.ok(c > eng.cfg.pollHotMs && c <= eng.cfg.pollFarMs + eng.cfg.cadenceJitterMs,
        `control broken: ${id} cadence ${c} is outside the far-poll band`);
      assert.ok(!alertIds.has(id), `control broken: ${id} raised a per-load alert - a believable close is not a hold`);
      assert.notStrictEqual((eng.scheduler.get(id) || {}).status, 'closed', `control broken: ${id} must not be retired`);
    }
    ok('CONTROL: a real 2h close and a close one minute inside the 30-day bound both arm exactly as today');
  }

  // --------------------------------------------- 3. RULING 1, HOLD half: no monitor is armed
  {
    for (const id of HELD) {
      assert.ok(!eng.monitors.has(id),
        `RULING 1, HOLD HALF: ${id} (closesAt=${JSON.stringify(rawClose(id))}) armed a monitor on restore - ${shown(id)}. `
        + 'The persisted close is taken RAW on the restore read, past the 30-day plausibility bound '
        + `(MAX_PLAUSIBLE_CLOSE_SKEW_MS = ${MAX_SKEW}) that this engine's own plausibleCloseAt applies to the LIVE read `
        + 'and to none of the restore reads. An unknown or implausible close on restore must HOLD the load - '
        + 'no monitor, no bid, no retirement - and tell the desk.');
    }
    ok('RULING 1 (hold): an implausible or absent persisted close arms NO monitor');
  }

  // --------------------------------------------- 4. RULING 1, HOLD half: no impossible belief
  {
    for (const [id, m] of eng.monitors) {
      const b = m.believedCloseAt;
      assert.ok(b === null || (Number.isFinite(b) && b >= Date.now() - MAX_SKEW && b <= Date.now() + MAX_SKEW),
        `RULING 1, HOLD HALF: restored monitor ${id} believes an impossible close (believedCloseAt=${JSON.stringify(b)}). `
        + 'A restored monitor may believe only null or a close inside the engine\'s own +/-30-day bound; '
        + 'the raw field admits the year-2100 placeholder, a 1 Jan 1970 zero, and an empty string, '
        + 'and _persistBelievedClose then writes that value back as the load\'s real close for the finalize path.');
    }
    ok('RULING 1 (hold): no restored monitor believes an impossible close');
  }

  // --------------------------------------------- 5. RULING 1, HOLD half: no NaN, no snipe cadence
  {
    for (const [id, m] of eng.monitors) {
      assert.ok(Number.isFinite(m.closesInMs),
        `RULING 1, HOLD HALF: restored monitor ${id} has closesInMs=${String(m.closesInMs)}. `
        + 'Math.max(0, NaN) is NaN, so the clamp written to guarantee a non-negative countdown returns a value '
        + 'that loses every comparison after it.');
    }
    for (const id of HELD) {
      if (!eng.monitors.has(id)) continue;
      const c = eng._cadence(mon(id).closesInMs, mon(id));
      assert.notStrictEqual(c, eng.cfg.pollHotMs,
        `RULING 1, HOLD HALF: ${id} (closesAt=${JSON.stringify(rawClose(id))}) resolved to the ${eng.cfg.pollHotMs}ms snipe cadence `
        + 'on a load whose close is not known at all - _cadence is a chain of `>` tests and a NaN countdown falls '
        + 'through both buckets. That is five reads per second per load, for the life of the process, against a '
        + 'shared vendor account whose rate budget and anti-detection posture both sit on that cadence.');
    }
    ok('RULING 1 (hold): no restored monitor has a NaN countdown and no held load polls at the snipe cadence');
  }

  // --------------------------------------------- 6. RULING 1, TELL half: the banner count is true
  {
    assert.ok(banner, 'the restart banner must be emitted');
    assert.strictEqual(banner.count, CONTROLS.length,
      `RULING 1, TELL HALF: the restart banner reports ${banner.count} resumed live auction(s) where only `
      + `${CONTROLS.length} really resumed - the ${HELD.length} held loads are counted as live because an implausible `
      + 'close is neither retired nor screened on the restore path. An operator who believes a held load came back '
      + 'hand-quotes none of them.');
    assert.strictEqual(resumed, CONTROLS.length,
      `RULING 1, TELL HALF: rehydrate() returned ${resumed} as the number that resumed, counting held loads as live auctions.`);
    ok('RULING 1 (tell): a held load is not counted as a resumed live auction');
  }

  // --------------------------------------------- 7. RULING 1: held, never retired
  {
    for (const id of HELD) {
      const it = eng.scheduler.get(id) || {};
      assert.notStrictEqual(it.status, 'closed',
        `RULING 1, HOLD HALF: ${id} was retired (status '${it.status}'). Ruling 1 forbids retiring an unknown close `
        + 'as a loss OR as unknown - the load is HELD for the desk.');
      assert.ok(it.won === null || it.won === undefined,
        `RULING 1, HOLD HALF: ${id} carries won=${JSON.stringify(it.won)}. A held load has no outcome: `
        + 'writing false records a fought loss on a load nothing ever bid.');
    }
    ok('RULING 1 (hold): a held load stays held - not closed, and no outcome written');
  }

  // --------------------------------------------- 8. RULING 1, TELL half: the desk hears about it
  {
    for (const id of HELD) {
      assert.ok(alertIds.has(id),
        `RULING 1, TELL HALF: ${id} (closesAt=${JSON.stringify(rawClose(id))}) was held with NO alert carrying its auctionId. `
        + 'The price-page gate says nothing fails silently after the price request page: a load the engine has '
        + 'silently stopped watching, with a human rate already entered against it, is bucket 3 and unacceptable. '
        + `Alerts seen with an auctionId: ${JSON.stringify([...alertIds])}`);
    }
    ok('RULING 1 (tell): every held load raises a desk-visible alert carrying its auctionId');
  }

  // --------------------------------------------- 9. the SECOND restore door: kill -> resume
  {
    const file2 = tmpFile('resume');
    const scheduled = Object.assign(base('ABSENT-SCHEDULED'), { status: 'scheduled' });
    fs.writeFileSync(file2, JSON.stringify({ savedAt: T0, intents: [scheduled] }), 'utf8');
    const ev2 = [];
    const eng2 = new BidEngine(adapter, new DurableScheduler(file2), {
      onEvent: (e) => ev2.push(e), log: SILENT, rand: () => 0.5,
    });
    eng2.log = SILENT;
    ENGINES.push(eng2);

    const id = 'ABSENT-SCHEDULED';
    const alerted = () => ev2.some((e) => e.type === 'alert' && e.auctionId === id);
    eng2.kill('operator kill switch');
    eng2.resume();
    const until = Date.now() + 2_000;
    while (Date.now() < until && !eng2.monitors.has(id) && !alerted()) await sleep(20);
    await sleep(50);

    const m2 = eng2.monitors.get(id) || {};
    if (eng2.monitors.has(id)) {
      assert.ok(Number.isFinite(m2.closesInMs),
        `RULING 1, HOLD HALF, RESUME DOOR: ${id} (no closesAt key at all) armed through the operator kill/resume `
        + `cycle with closesInMs=${String(m2.closesInMs)}, believedCloseAt=${JSON.stringify(m2.believedCloseAt)}. `
        + 'resume() re-plans a scheduled intent\'s wake directly and never passes through the retirement sweep, '
        + 'so this door takes the persisted close raw exactly as the rehydrate door does.');
      assert.notStrictEqual(eng2._cadence(m2.closesInMs, m2), eng2.cfg.pollHotMs,
        `RULING 1, HOLD HALF, RESUME DOOR: ${id} resolved to the ${eng2.cfg.pollHotMs}ms snipe cadence through the `
        + 'resume door, on a load whose close is not known at all.');
    }
    assert.ok(!eng2.monitors.has(id),
      `RULING 1, HOLD HALF, RESUME DOOR: ${id} (no closesAt key at all) armed a monitor after an operator `
      + `kill/resume cycle - armed=true closesInMs=${String(m2.closesInMs)} believedCloseAt=${JSON.stringify(m2.believedCloseAt)}. `
      + 'A hold implemented only in the retirement sweep is walked straight back through this door - same load, '
      + 'same unknown close, same bid risk.');
    assert.ok(alerted(),
      `RULING 1, TELL HALF, RESUME DOOR: ${id} passed through kill/resume with NO alert carrying its auctionId. `
      + 'The desk is owed the same notice on this door as on the rehydrate door - a load held silently after an '
      + 'operator lifts the kill switch is bucket 3 of the price-page gate.');
    ok('RULING 1 (hold + tell): the operator kill/resume door holds an unknown close too');
  }

  cleanup();
  const EXPECTED = 9;
  assert.strictEqual(pass, EXPECTED,
    `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => {
  cleanup();
  console.error(e);
  process.exit(1);
});
