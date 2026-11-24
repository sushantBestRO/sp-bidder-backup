'use strict';
/**
 * A GoComet load's round cap comes from its customer record, per plant, and is saved per load.
 *
 * Regression target: PR-T2a "GoComet final-round timing", contract section 4,
 * ruling Q1(a) (BUILD PLAN 2026-09-24).
 *
 * THE DEFECT. Waaree's final round is the 3rd extension at every plant except Kutch/Samakhiyali,
 * which is uncapped. On d3bf803 nothing can hold or carry that:
 *   - validateCustomer (src/model/customerStore.js) rebuilds the doc from an explicit field list
 *     (customerId, label, aliases, margin, auction, enabled, previousIds, rules), so a roundPolicy
 *     on the record is silently dropped on every console save, and a malformed one is never refused
 *     (checks 2, 3, 5);
 *   - src/model/resolve.js has no resolveRoundPolicy (checks 6, 7);
 *   - armFromRequest builds meta from an explicit list, arm() persists an explicit list and
 *     _intentToArm restores an explicit list, so no round policy reaches the durable intent or
 *     survives a restart (checks 9, 10).
 *
 * WHAT MUST NOT MOVE (green on the unfixed tree too):
 *   1. the Waaree record's margin survives validateCustomer and resolveMargin still resolves its band.
 *   4. a customer with no roundPolicy validates byte-identically to today: no roundPolicy key at all.
 *   8. the carry harness is live: a PriceRequestStore wired to the real CustomerStore arms a GoComet
 *      load whose durable intent carries the Waaree band, and no bid reaches the adapter.
 * If any of these fails the harness is dead and no mechanism result in this file means anything.
 *
 * Offline and deterministic: real CustomerStore / resolve / PriceRequestStore / armFromRequest /
 * BidEngine / DurableScheduler over memory stores and os.tmpdir() intent files; only the adapter is
 * stubbed, with the REAL gocometAdapter capabilities. Every close is 20 minutes out, so no tick can
 * reach a bid; the placeBid counter confirms it. No network, no sleeps.
 *
 *   node scripts/test-gocomet-round-policy-config.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files + data dir), not app state
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-round-policy-'));
process.env.SP_DATA_DIR = DATA_DIR;
process.env.STORE_BACKEND = 'memory';

const { createStore } = require('../src/store');
const { CustomerStore, validateCustomer } = require('../src/model/customerStore');
const resolveMod = require('../src/model/resolve');
const { PriceRequestStore, armFromRequest } = require('../src/pricing/priceRequests');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const EXPECTED_CHECKS = 10;
const CAUSE = 'the per-plant round cap (roundPolicy) is dropped by validateCustomer, has no resolver '
  + '(resolveRoundPolicy), and is never carried onto the load\'s durable intent';

const KUTCH = 'Survey No 123, Samakhiyali, Kutch, Gujarat';
const DEGAM = 'Degam (Survey No. 1934, NH-48, Chikhli)';
const WAAREE_BAND = { marginsPct: [9, 7.2, 1.8], minMarginPct: 1 };
const ROUND_POLICY = {
  finalAfterExtensions: 3,
  byOrigin: [{ match: ['samakhiyali', 'orpat', 'kutch'], finalAfterExtensions: null }],
};
const waaree = (over = {}) => ({
  customerId: 'waaree', label: 'Waaree', aliases: ['Waaree Energies'],
  margin: { ...WAAREE_BAND, marginsPct: WAAREE_BAND.marginsPct.slice() },
  roundPolicy: JSON.parse(JSON.stringify(ROUND_POLICY)), ...over,
});
const durian = () => ({ customerId: 'durian', label: 'Durian Industries', aliases: ['Durian'],
  margin: { marginsPct: [12, 8], minMarginPct: 6 } });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const CLEAN = [];
let seq = 0;
const tmp = () => {
  const f = path.join(os.tmpdir(), `gc-round-policy-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  return f;
};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
let bidAttempts = 0;

const adapter = {
  capabilities: () => ({ standingPriceVisible: false, minDecrement: 500, allowsTieRate: false,
    revisionLimit: 3, closeModel: 'soft', reactiveClose: true, extensionCeiling: null,
    extensionIncrementMs: 300000, snipeBudgetMs: 4500 }),
  ensureSession: async () => ({}),
  async getAuctionState() {
    return { ok: true, status: 'live', closeModel: 'soft', closesAtMs: Date.now() + 1_200_000,
      closesInMs: 1_200_000, extendMs: 300000, extendCount: null, extensionCeiling: null,
      myRank: null, totalBidders: null, standingL1Price: null, revisionsLeft: 3, revisionLimit: 3,
      minDecrement: 500, measuredRttMs: 20 };
  },
  async placeBid() { bidAttempts += 1; return { accepted: false, error: 'offline test adapter' }; },
};

const newEngine = (file) => new BidEngine(adapter, new DurableScheduler(file), {
  config: { openAtMs: 15_000, floorWindowMs: 2_500, minInterFireMs: 0, cadenceJitterMs: 0, openJitterMs: 0 },
  onEvent: () => {}, log: quiet,
});
const stopTimers = (eng) => { for (const m of eng.monitors.values()) { if (m.timer) { clearTimeout(m.timer); m.timer = null; } } };

async function carryRig() {
  const customers = new CustomerStore({ store: createStore({ backend: 'memory' }) });
  await customers.upsert(waaree());
  const requests = new PriceRequestStore({ store: createStore({ backend: 'memory' }),
    marginsPct: [5, 4, 3], minMarginPct: 3, customersProvider: customers, platformKey: 'gocomet' });
  const file = tmp();
  const engine = newEngine(file);
  const armLoad = async (id, origin) => {
    const req = await requests.createForLoad({
      id, lane: { origin, destination: 'Kakinada' }, companyName: 'Waaree Energies Ltd.',
      equipment: '32ft SXL', units: 1, quoteType: 'FTL', closesAt: Date.now() + 1_200_000,
      startsAt: Date.now() - 60_000, status: 'live', softClose: true, closeModelKnown: true,
    }, { platformKey: 'gocomet', deadlineAt: Date.now() + 600_000 });
    const captured = await requests.capture(req.id, { cost: 50_000 });
    const m = armFromRequest(engine, captured);
    stopTimers(engine);
    return m;
  };
  const done = () => { stopTimers(engine); try { engine.kill('test'); } catch (_) {} };
  return { customers, requests, engine, file, armLoad, done };
}

const results = [];
async function check(n, name, kind, fn) {
  let failure = null;
  try {
    failure = await fn();
  } catch (e) {
    failure = `threw: ${e && e.stack ? e.stack : e}`;
  }
  results.push({ n, name, kind, failure });
  console.log(failure ? `  FAIL ${n}. ${name} [${kind}] - ${failure}` : `  ok   ${n}. ${name} [${kind}]`);
}

async function main() {
  await check(1, 'waaree_margin_survives_and_resolves', 'control', async () => {
    const out = validateCustomer(waaree());
    if (!same(out.margin, WAAREE_BAND)) return `validateCustomer margin ${JSON.stringify(out.margin)}, expected ${JSON.stringify(WAAREE_BAND)}`;
    const band = resolveMod.resolveMargin({ platformKey: 'gocomet', companyName: 'Waaree Energies Ltd.',
      customers: [out], assignments: [], defaults: { marginsPct: [5, 4, 3], minMarginPct: 3 } });
    if (!same(band.marginsPct, WAAREE_BAND.marginsPct) || band.minMarginPct !== 1 || band.source !== 'customer:waaree') {
      return `resolveMargin gave ${JSON.stringify(band)}, expected the Waaree band from customer:waaree`;
    }
    return null;
  });

  await check(2, 'validateCustomer_carries_roundPolicy', 'mechanism', async () => {
    const out = validateCustomer(waaree());
    if (same(out.roundPolicy, ROUND_POLICY)) return null;
    return `validateCustomer returned roundPolicy ${JSON.stringify(out.roundPolicy)}, expected ${JSON.stringify(ROUND_POLICY)} `
      + '- a console save of the Waaree record silently drops the per-plant round cap';
  });

  await check(3, 'customerStore_upsert_stores_roundPolicy', 'mechanism', async () => {
    const cs = new CustomerStore({ store: createStore({ backend: 'memory' }) });
    const returned = await cs.upsert(waaree());
    const stored = await cs.get('waaree');
    if (!stored) return 'HARNESS: upsert stored nothing under waaree';
    const bad = [];
    if (!same(returned.roundPolicy, ROUND_POLICY)) bad.push(`returned ${JSON.stringify(returned.roundPolicy)}`);
    if (!same(stored.roundPolicy, ROUND_POLICY)) bad.push(`stored ${JSON.stringify(stored.roundPolicy)}`);
    return bad.length ? `CustomerStore.upsert roundPolicy ${bad.join(', ')}, expected ${JSON.stringify(ROUND_POLICY)}` : null;
  });

  await check(4, 'customer_without_roundPolicy_unchanged', 'pin', async () => {
    const out = validateCustomer(durian());
    const expected = { customerId: 'durian', label: 'Durian Industries', aliases: ['Durian Industries', 'Durian'],
      margin: { marginsPct: [12, 8], minMarginPct: 6 }, auction: null, enabled: true };
    if ('roundPolicy' in out) return `a customer with no roundPolicy gained the key: ${JSON.stringify(out.roundPolicy)}`;
    return same(out, expected) ? null : `validateCustomer output changed: ${JSON.stringify(out)}`;
  });

  await check(5, 'bad_roundPolicy_shapes_refused', 'mechanism', async () => {
    const entry = (e) => ({ finalAfterExtensions: 3, byOrigin: [e] });
    const cases = [
      ['top -1', { finalAfterExtensions: -1 }],
      ['top 2.5', { finalAfterExtensions: 2.5 }],
      ["top '3'", { finalAfterExtensions: '3' }],
      ['entry -1', entry({ match: ['kutch'], finalAfterExtensions: -1 })],
      ['entry 2.5', entry({ match: ['kutch'], finalAfterExtensions: 2.5 })],
      ["entry '3'", entry({ match: ['kutch'], finalAfterExtensions: '3' })],
      ['byOrigin string', { finalAfterExtensions: 3, byOrigin: 'kutch' }],
      ['byOrigin object', { finalAfterExtensions: 3, byOrigin: { match: ['kutch'], finalAfterExtensions: null } }],
      ['match []', entry({ match: [], finalAfterExtensions: null })],
      ["match ['']", entry({ match: [''], finalAfterExtensions: null })],
      ['match missing', entry({ finalAfterExtensions: null })],
    ];
    const accepted = [];
    for (const [label, rp] of cases) {
      try {
        validateCustomer(waaree({ roundPolicy: rp }));
        accepted.push(`${label} (accepted)`);
      } catch (e) {
        if (!e || e.code !== 'BAD_INPUT') accepted.push(`${label} (threw ${e && e.code ? e.code : e} not BAD_INPUT)`);
      }
    }
    return accepted.length ? `${accepted.length} of ${cases.length} malformed roundPolicy shapes not refused with BAD_INPUT: ${accepted.join('; ')}` : null;
  });

  await check(6, 'resolveRoundPolicy_exists', 'mechanism', async () => (typeof resolveMod.resolveRoundPolicy === 'function'
    ? null : `src/model/resolve.js exports no resolveRoundPolicy (typeof ${typeof resolveMod.resolveRoundPolicy})`));

  await check(7, 'resolveRoundPolicy_per_plant', 'mechanism', async () => {
    const fn = resolveMod.resolveRoundPolicy;
    if (typeof fn !== 'function') return 'resolveRoundPolicy is missing (see check 6), no plant can be resolved';
    const customers = [{ ...waaree(), enabled: true }, { ...durian(), enabled: true }];
    const bad = [];
    const r = (companyName, origin) => fn({ companyName, origin, customers });
    const kutch = r('Waaree Energies Ltd', KUTCH);
    if (!(kutch && kutch.finalAfterExtensions === null && typeof kutch.source === 'string')) bad.push(`Kutch -> ${JSON.stringify(kutch)}, expected {finalAfterExtensions: null, source: <string>}`);
    const degam = r('Waaree Energies Ltd', DEGAM);
    if (!(degam && degam.finalAfterExtensions === 3)) bad.push(`Degam/Chikhli -> ${JSON.stringify(degam)}, expected 3`);
    const other = r('Waaree Energies Ltd', 'Somewhere New, Rajasthan');
    if (!(other && other.finalAfterExtensions === 3)) bad.push(`unrecognised Waaree origin -> ${JSON.stringify(other)}, expected 3`);
    const upper = r('Waaree Energies Ltd', 'SAMAKHIYALI');
    if (!(upper && upper.finalAfterExtensions === null)) bad.push(`'SAMAKHIYALI' -> ${JSON.stringify(upper)}, expected null (case-folded)`);
    const noPolicy = r('Durian Industries Ltd', KUTCH);
    if (noPolicy !== null) bad.push(`customer without roundPolicy -> ${JSON.stringify(noPolicy)}, expected null`);
    const unknown = r('Havells India', KUTCH);
    if (unknown !== null) bad.push(`unknown company -> ${JSON.stringify(unknown)}, expected null`);
    return bad.length ? `resolveRoundPolicy: ${bad.join('; ')}` : null;
  });

  let rig = null;
  await check(8, 'carry_harness_arms_waaree_band', 'control', async () => {
    rig = await carryRig();
    const m = await rig.armLoad('GC-KUTCH', KUTCH);
    if (!m) return 'HARNESS: armFromRequest returned no monitor';
    const it = rig.engine.scheduler.get('GC-KUTCH');
    if (!it) return 'HARNESS: arm wrote no durable intent';
    if (!same(it.marginsPct, WAAREE_BAND.marginsPct) || it.minMarginPct !== 1) {
      return `HARNESS: intent band ${JSON.stringify(it.marginsPct)}/${it.minMarginPct}, expected the Waaree band from the customer record`;
    }
    if (it.platformKey !== 'gocomet' || !it.lane || it.lane.origin !== KUTCH) return `HARNESS: intent platform/lane wrong: ${it.platformKey} ${JSON.stringify(it.lane)}`;
    return null;
  });

  await check(9, 'roundPolicy_carried_onto_durable_intent', 'mechanism', async () => {
    if (!rig) return 'HARNESS: no carry rig';
    await rig.armLoad('GC-DEGAM', DEGAM);
    const k = rig.engine.scheduler.get('GC-KUTCH');
    const d = rig.engine.scheduler.get('GC-DEGAM');
    if (!k || !d) return 'HARNESS: missing durable intent';
    const bad = [];
    if (!(k.roundPolicy && k.roundPolicy.finalAfterExtensions === null)) bad.push(`Kutch intent roundPolicy ${JSON.stringify(k.roundPolicy)}, expected {finalAfterExtensions: null}`);
    if (!(d.roundPolicy && d.roundPolicy.finalAfterExtensions === 3)) bad.push(`Degam intent roundPolicy ${JSON.stringify(d.roundPolicy)}, expected {finalAfterExtensions: 3}`);
    return bad.length ? `armFromRequest -> arm() carries no per-plant round cap: ${bad.join('; ')}` : null;
  });

  await check(10, 'roundPolicy_saved_per_load_across_restart', 'mechanism', async () => {
    if (!rig) return 'HARNESS: no carry rig';
    try {
      const cur = await rig.customers.get('waaree');
      await rig.customers.upsert({ ...cur, roundPolicy: { finalAfterExtensions: 3,
        byOrigin: [{ match: ['samakhiyali', 'orpat', 'kutch'], finalAfterExtensions: 5 }] } });
      rig.done();
      const eng2 = newEngine(rig.file);
      try {
        await eng2.rehydrate();
        stopTimers(eng2);
        const m = eng2.monitors.get('GC-KUTCH');
        if (!m) return 'HARNESS: rehydrate did not re-arm the Kutch load';
        const it = eng2.scheduler.get('GC-KUTCH');
        const bad = [];
        if (!(it && it.roundPolicy && it.roundPolicy.finalAfterExtensions === null)) bad.push(`intent roundPolicy ${JSON.stringify(it && it.roundPolicy)}`);
        if (!(m.meta && m.meta.roundPolicy && m.meta.roundPolicy.finalAfterExtensions === null)) bad.push(`rehydrated meta.roundPolicy ${JSON.stringify(m.meta && m.meta.roundPolicy)}`);
        return bad.length ? `after the record changed Kutch to 5 and a restart: ${bad.join(', ')}; expected the load's own {finalAfterExtensions: null}` : null;
      } finally { stopTimers(eng2); try { eng2.kill('test'); } catch (_) {} }
    } finally { rig.done(); }
  });
}

main().catch((e) => {
  results.push({ n: 0, name: 'harness', kind: 'control', failure: `threw: ${e && e.stack ? e.stack : e}` });
}).then(() => {
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}

  const isHarness = (x) => x.failure && (x.kind !== 'mechanism' || /^(HARNESS|threw:)/.test(x.failure));
  const harness = results.filter(isHarness);
  const mech = results.filter((x) => x.failure && !isHarness(x));
  if (harness.length || bidAttempts > 0 || results.length !== EXPECTED_CHECKS) {
    console.log(`\nFAIL - HARNESS/PIN: ${harness.map((x) => `${x.n}. ${x.name}`).join(', ') || 'no check'} failed, `
      + `${bidAttempts} bid attempt(s) reached the fake adapter, ${results.length} of ${EXPECTED_CHECKS} checks ran; `
      + 'the harness, a control or a pin is broken, so the mechanism results above are not trustworthy');
    process.exit(1);
  }
  if (mech.length) {
    console.log(`\nFAIL - ${mech.length} of ${results.length} checks (${mech.map((x) => x.n).join(', ')}), first at check ${mech[0].n}: ${CAUSE}`);
    process.exit(1);
  }
  console.log(`\nPASS - ${results.length} checks: the per-plant round cap is stored, resolved and saved per load`);
  process.exit(0);
});
