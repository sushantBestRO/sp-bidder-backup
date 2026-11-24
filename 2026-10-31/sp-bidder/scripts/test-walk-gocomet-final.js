'use strict';
/**
 * @requires-summary-line
 * T9 final-window walk: GoComet's final round (W7, W9, ruling 48; owner ruling of 26 Sep: the
 * pre-emptive floor switch stays off for every customer, Waaree included, and is pinned working when on).
 *
 * In GoComet's final round the walk takes min(attempts left, band prices below ours) steps from
 * close - steps x 6,000 - (clockErrorMs 1,000 + safetyMarginMs 500). At rank 1 in a CONFIRMED final
 * round (FINAL, HIGH) it holds, unless the customer's pre-emptive-floor switch is on: then the lowest
 * band price goes at the buzzer even at rank 1. An UNCERTAIN round never takes the switch. A pre-final
 * round spends a middle price only with two attempts or more; outranked with one attempt left, the
 * lowest goes at its last-step deadline rather than waiting for a final round nobody may open.
 *
 * Band: cost 50,000, margins 9 / 7.2 / 1.8, minimum 1 -> 54,500 / 53,600 / 50,900.
 *
 *   node scripts/test-walk-gocomet-final.js
 */
const H = require('./lib/walk-harness');

const EXPECTED = 13;
const BAND = { cost: 50_000, marginsPct: [9, 7.2, 1.8], minMarginPct: 1 };
const [G0, , G2] = [54_500, 53_600, 50_900];
const walkGc = H.walkCfg('gc');
const FINAL_NOW = { roundPolicy: { finalAfterExtensions: 0 } };
const GC_STEP_MS = 299_000;

const GOLDEN = {
  oneAttempt: ['50900@6500'],
  rank1Off: ['50900@6500'],
  rank1On: ['50900@6500'],
  uncertainRank1: [],
  uncertainOutranked: ['50900@6500'],
  precapGuard: ['50900@6500'],
};

(async () => {
  console.log('T9 walk - GoComet final round');

  await H.check('18 gc-steps-attempts: FINAL, 1 attempt left, 2 prices below -> one step, at the walk start (7,500), the lowest (D-A)', async () => {
    const script = async (r) => {
      r.seedStanding(0, 1);
      for (const cd of [19_500, 12_000, 7_600, 7_500, 6_500, 5_000]) await r.at(cd, { rank: 2 });
    };
    const { off, on } = await H.pair({ platform: 'gc', band: BAND, gc: FINAL_NOW }, walkGc, script);
    const bad = [];
    if (!H.same(on.trace(), [`${G2}@7500`])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected only the lowest ${G2} at 7,500`);
    const ctl = H.offMatches('oneAttempt', off.trace(), GOLDEN.oneAttempt);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('19 gc-rank1-confirmed-stop: FINAL HIGH, rank 1, a Waaree load with the switch at its default (off) -> hold through the close', async () => {
    const script = async (r) => {
      r.seedStanding(0, 2);
      for (const cd of [19_500, 12_000, 7_500, 6_500, 5_000, 3_000, 1_000]) await r.at(cd, { rank: 1 });
    };
    const { off, on } = await H.pair({ platform: 'gc', band: BAND, gc: FINAL_NOW }, walkGc, script);
    const bad = [];
    const v = on.eng.roundVerdict(on.m);
    if (v.verdict !== 'FINAL' || v.confidence !== 'HIGH') bad.push(`HARNESS: verdict ${v.verdict}/${v.confidence}, expected FINAL/HIGH`);
    if (on.writes.length) bad.push(`walk on sent ${JSON.stringify(on.trace())} at rank 1 with the switch off`);
    const ctl = H.offMatches('rank1Off', off.trace(), GOLDEN.rank1Off);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('20 gc-rank1-preemptive-switch-on: FINAL HIGH, rank 1, customer switch turned on -> the lowest band price at the last-step deadline of the walk (7,500; plan E); the switch rides the customer record onto the load and survives a restart', async () => {
    const script = async (r) => {
      r.seedStanding(0, 2);
      for (const cd of [19_500, 12_000, 7_500, 7_000, 6_500, 5_000, 3_000]) await r.at(cd, { rank: 1 });
    };
    const opts = { platform: 'gc', band: BAND, gc: Object.assign({ preEmptiveFloorAtRankOne: true }, FINAL_NOW) };
    const { off, on } = await H.pair(opts, walkGc, script);
    const bad = [];
    if (!H.same(on.trace(), [`${G2}@7500`])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected only the lowest ${G2} at the 7,500 last-step deadline`);
    const ctl = H.offMatches('rank1On', off.trace(), GOLDEN.rank1On);
    if (ctl) bad.push(ctl);

    // The customer record carries the switch; it resolves onto the price request and the armed meta.
    try {
      const { validateCustomer } = require('../src/model/customerStore');
      const resolve = require('../src/model/resolve');
      const c = validateCustomer({ label: 'Acme Freight', preEmptiveFloorAtRankOne: true });
      if (c.preEmptiveFloorAtRankOne !== true) bad.push('validateCustomer dropped preEmptiveFloorAtRankOne: true');
      const plain = validateCustomer({ label: 'Waaree Energies' });
      if ('preEmptiveFloorAtRankOne' in plain) bad.push('a customer without the switch gained a preEmptiveFloorAtRankOne key');
      let refused = null;
      try { validateCustomer({ label: 'X', preEmptiveFloorAtRankOne: 'yes' }); } catch (e) { refused = e; }
      if (!refused || refused.code !== 'BAD_INPUT') bad.push('validateCustomer accepted a non-boolean preEmptiveFloorAtRankOne');
      if (typeof resolve.resolvePreEmptiveFloor !== 'function') bad.push('resolve.resolvePreEmptiveFloor is missing');
      else {
        const customers = [c, plain];
        if (resolve.resolvePreEmptiveFloor({ companyName: 'Acme Freight Ltd', customers }) !== true) bad.push('a customer with the switch on did not resolve to on');
        if (resolve.resolvePreEmptiveFloor({ companyName: 'Waaree Energies Ltd', customers }) !== false) bad.push('Waaree, without the switch, did not resolve to off');
      }
    } catch (e) { bad.push(`customer switch plumbing threw: ${e.message}`); }

    const r = H.load(Object.assign({}, opts, { walk: walkGc }));
    r.seedStanding(0, 2);
    await r.at(60_000, { rank: 1 });
    r.eng.scheduler.update(r.m.auctionId, { firedRungs: [0], landedBids: 1, landedBidPrice: G0, everBid: true, revisionsLeft: 2 });
    await r.restart();
    if (!(r.m.meta && r.m.meta.preEmptiveFloorAtRankOne === true)) bad.push('the switch did not survive a restart (meta.preEmptiveFloorAtRankOne lost on rehydrate)');
    for (const cd of [7_600, 7_000, 6_500]) await r.at(cd, { rank: 1 });
    if (!H.same(r.writes.map((w) => w.price), [G2])) bad.push(`after a restart walk on sent ${JSON.stringify(r.trace())}, expected the lowest ${G2} at the buzzer`);
    r.done();
    return bad.join('; ') || null;
  });

  await H.check('21 gc-rank1-uncertain: UNCERTAIN (off-grid move), rank 1, switch on -> hold; outranked in the same round -> the walk, not the buzzer floor', async () => {
    const script = (rank) => async (r) => {
      r.seedStanding(0, 2);
      await r.at(60_000, { rank });
      await r.extend(200_000, 260_000, { rank });
      for (const cd of [19_500, 13_000, 12_000, 7_500, 7_000, 6_500, 5_000]) await r.at(cd, { rank });
    };
    const opts = { platform: 'gc', band: BAND, gc: { preEmptiveFloorAtRankOne: true, roundPolicy: { finalAfterExtensions: 3 } } };
    const lead = await H.pair(opts, walkGc, script(1));
    const bad = [];
    const v = lead.on.eng.roundVerdict(lead.on.m);
    if (v.verdict !== 'UNCERTAIN') bad.push(`HARNESS: verdict ${v.verdict}/${v.reason}, expected UNCERTAIN`);
    if (lead.on.writes.length) bad.push(`at rank 1 in an UNCERTAIN round walk on sent ${JSON.stringify(lead.on.trace())} (the switch applies only to a confirmed final round)`);
    let ctl = H.offMatches('uncertainRank1', lead.off.trace(), GOLDEN.uncertainRank1);
    if (ctl) bad.push(ctl);
    const out = await H.pair(opts, walkGc, script(2));
    if (!H.same(out.on.trace(), [`${53_600}@13000`, `${G2}@7500`])) {
      bad.push(`outranked in the UNCERTAIN round walk on sent ${JSON.stringify(out.on.trace())}, expected 53600 at 13,000 then ${G2} at 7,500 once a fresh outranked read arrives (W11)`);
    }
    ctl = H.offMatches('uncertainOutranked', out.off.trace(), GOLDEN.uncertainOutranked);
    if (ctl) bad.push(ctl);
    return bad.join('; ') || null;
  });

  await H.check('22 gc-precap-attempts-guard: NOT_FINAL, outranked, 1 attempt left -> no middle price; the last attempt goes as the lowest at the pre-final round\'s last-step deadline (never forfeited, 260928NXAW), and the final round has nothing left', async () => {
    let preFinal = null;
    const script = async (r) => {
      r.seedStanding(0, 1);
      for (const cd of [60_000, 19_500, 12_000, 7_500, 6_500, 3_000]) await r.at(cd, { rank: 2 });
      await r.at(0, { rank: 2 });
      preFinal = r.trace();
      r.ctrl.close += GC_STEP_MS;
      for (const cd of [290_000, 19_500, 12_000, 7_600, 7_500, 6_500, 5_000]) await r.at(cd, { rank: 2 });
    };
    const opts = { platform: 'gc', band: BAND, gc: { roundPolicy: { finalAfterExtensions: 1 } } };
    const { off, on } = await H.pair(opts, walkGc, script);
    const bad = [];
    if (!H.same(preFinal, [`${G2}@7500`]) || !H.same(on.trace(), [`${G2}@7500`])) {
      bad.push(`walk on sent ${JSON.stringify(preFinal)} in the pre-final round and ${JSON.stringify(on.trace())} in all, expected only the lowest ${G2} at 7,500 of the pre-final round`);
    }
    const ctl = H.offMatches('precapGuard', off.trace(), GOLDEN.precapGuard);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('pin: GoComet final round, 3 attempts, 3 prices, rank never visible -> steps at 19,500, 13,500 and 7,500 (D-C deadlines; the last one on the clock, no read slack)', async () => {
    const r = H.load({ platform: 'gc', band: BAND, gc: FINAL_NOW, walk: walkGc });
    for (let cd = 25_000; cd >= 3_000; cd -= 500) await r.at(cd, { rank: null });
    r.done();
    if (H.same(r.trace(), [`${G0}@19500`, `53600@13500`, `${G2}@7500`])) return null;
    return `walk on sent ${JSON.stringify(r.trace())}, expected 54500@19500, 53600@13500, 50900@7500`;
  });

  await H.check('pin: once the lowest price of the walk stands, later reads raise no "new rate cannot be bid" notice (SP and GoComet)', async () => {
    const bad = [];
    // Bids to spare after the lowest lands, so the later reads reach the decision.
    const gc = H.load({ platform: 'gc', band: { cost: 50_000, marginsPct: [9, 1.8], minMarginPct: 1 }, gc: FINAL_NOW, walk: walkGc });
    for (let cd = 25_000; cd >= 1_000; cd -= 500) await gc.at(cd, { rank: gc.writes.length ? 2 : null });
    gc.done();
    const sp = H.load({ sp: { revisionLimit: 5 }, walk: H.walkCfg('sp', { stepTimeMs: 2_000, safetyMarginMs: 500 }) });
    for (let cd = 8_000; cd >= 200; cd -= 100) await sp.at(cd, { rank: sp.writes.length ? 2 : null });
    sp.done();
    for (const [name, r] of [['GoComet', gc], ['SuperProcure', sp]]) {
      if (!r.writes.length || r.writes[r.writes.length - 1].price !== r.ladder[r.ladder.length - 1]) bad.push(`${name}: HARNESS: the walk did not end on its lowest price (${JSON.stringify(r.trace())})`);
      const alerts = r.events.filter((e) => e.type === 'alert' && e.kind === 'reprice_unreachable_ladder');
      if (alerts.length) bad.push(`${name}: raised reprice_unreachable_ladder after its own lowest price landed`);
    }
    return bad.join('; ') || null;
  });

  await H.check('pin finalShotWithoutRead (latency-map row 4): FINAL HIGH -> the last step fires on the clock at 7,500 with no read; UNCERTAIN -> a read comes first', async () => {
    const bad = [];
    const run = async (gcOpts, offGrid, walk = walkGc) => {
      const r = H.load({ platform: 'gc', band: BAND, gc: gcOpts, walk });
      r.seedStanding(0, 1);
      await r.at(60_000, { rank: 2 });
      if (offGrid) await r.extend(200_000, 260_000, { rank: 2 });
      await r.at(9_000, { rank: 2 });
      const v = r.eng.roundVerdict(r.m);
      const delay = r.eng._cadence(9_000, r.m);
      const reads = r.ctrl.reads;
      H.setNow(r.close - 9_000 + delay);
      await r.eng._tick(r.m);
      if (r.m.timer) { clearTimeout(r.m.timer); r.m.timer = null; }
      r.done();
      return { delay, readsDuring: r.ctrl.reads - reads, trace: r.trace(), v };
    };
    const fin = await run(FINAL_NOW, false);
    if (fin.v.verdict !== 'FINAL' || fin.v.confidence !== 'HIGH') bad.push(`HARNESS: verdict ${fin.v.verdict}/${fin.v.confidence}`);
    if (fin.delay !== 1_500 || fin.readsDuring !== 0 || !H.same(fin.trace, [`${G2}@7500`])) {
      bad.push(`FINAL HIGH: next tick in ${fin.delay} ms with ${fin.readsDuring} reads, sent ${JSON.stringify(fin.trace)}; expected 1500 ms, 0 reads, the lowest at 7,500`);
    }
    const unc = await run({ roundPolicy: { finalAfterExtensions: 3 } }, true);
    if (unc.v.verdict !== 'UNCERTAIN') bad.push(`HARNESS: off-grid verdict ${unc.v.verdict}`);
    if (unc.readsDuring !== 1) bad.push(`UNCERTAIN: the step tick made ${unc.readsDuring} reads, expected a fresh read`);
    const off = await run(FINAL_NOW, false, H.walkCfg('gc', { finalShotWithoutRead: false }));
    if (off.readsDuring !== 1) bad.push(`with finalShotWithoutRead false the step tick made ${off.readsDuring} reads, expected a fresh read`);
    return bad.join('; ') || null;
  });

  await H.check('pin: GoComet clockErrorMs comes from the read when the adapter publishes it (100 after the whole-second snap), the setting otherwise', async () => {
    const bad = [];
    const first = async (err) => {
      const r = H.load({ platform: 'gc', band: BAND, gc: Object.assign({ clockErrorMs: err }, FINAL_NOW), walk: walkGc });
      for (let cd = 21_000; cd >= 15_000; cd -= 100) { await r.at(cd, { rank: null }); if (r.writes.length) break; }
      r.done();
      return r.writes.length ? r.writes[0].cd : null;
    };
    const published = await first(100);
    if (published !== 18_600) bad.push(`published clockErrorMs 100: the walk started at ${published}, expected 18,600 (12,000 + 6,000 + 100 + 500)`);
    const absent = await first(undefined);
    if (absent !== 19_500) bad.push(`no published clockErrorMs: the walk started at ${absent}, expected 19,500 (the 1,000 setting)`);
    const { GoCometAdapter } = require('../src/platform/gocometAdapter');
    const at = 1_800_000_000_000;
    const body = (secs) => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: {
      bid_closing_in: secs, vendor_rank: 2, revisions_left: 3, total_revisions: 0, current_server_time: new Date(at).toISOString() } }) });
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/[+]/g, '-').replace(/[/]/g, '_');
    const token = `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64({ exp: Math.floor(at / 1000) + 86_400, user_id: 'u' })}.sig`;
    for (const [secs, want] of [[30, 100], [30.4, 1_000]]) {
      try {
        const a = new GoCometAdapter({ token, fetchImpl: async () => body(secs), now: () => at, sleep: async () => {}, log: H.quiet });
        const st = await a.getAuctionState('K1');
        if (!st || st.clockErrorMs !== want) bad.push(`adapter with bid_closing_in ${secs}: clockErrorMs ${st && st.clockErrorMs}, expected ${want} (${JSON.stringify(st && { ok: st.ok, closesInMs: st.closesInMs })})`);
      } catch (e) { bad.push(`adapter read threw: ${e.message}`); }
    }
    return bad.join('; ') || null;
  });

  await H.check('pin (plan H): GoComet prepares its quote before the first walk step - once, inside 4,000 ms of the start, and a read is aimed there', async () => {
    const r = H.load({ platform: 'gc', band: BAND, gc: FINAL_NOW, walk: walkGc });
    await r.at(40_000, { rank: null });
    const delay = r.eng._cadence(40_000, r.m);
    for (const cd of [23_600, 23_000, 21_000, 19_500]) await r.at(cd, { rank: null });
    r.done();
    const bad = [];
    if (delay !== 40_000 - 23_000) bad.push(`from 40,000 the next read is ${delay} ms away, expected one aimed at 23,000 (half a read inside start 19,500 + 4,000)`);
    if (r.ctrl.prepares.length !== 1 || !(r.ctrl.prepares[0].cd <= 23_500 && r.ctrl.prepares[0].cd > 19_500)) bad.push(`prepareQuote calls ${JSON.stringify(r.ctrl.prepares)}, expected one inside (19,500, 23,500]`);
    if (!H.same(r.trace(), [`${G0}@19500`])) bad.push(`walk on sent ${JSON.stringify(r.trace())}, expected the top price at 19,500`);
    return bad.join('; ') || null;
  });

  await H.check('pin: GoComet is never held for its write runway (ruling 51 (c)) - an unbid final round first read at 3,000 still sends the lowest', async () => {
    const r = H.load({ platform: 'gc', band: BAND, gc: FINAL_NOW, walk: walkGc });
    await r.at(3_000, { rank: null });
    r.done();
    return H.same(r.trace(), [`${G2}@3000`]) ? null : `an unbid GoComet final round read first at 3,000 sent ${JSON.stringify(r.trace())}, expected the lowest best effort`;
  });

  await H.check('pin (replay finding): an uncapped round aims its read at the single-step start (7,000), not at a deadline above it', async () => {
    const r = H.load({ platform: 'gc', band: BAND, gc: { roundPolicy: { finalAfterExtensions: null } }, walk: walkGc });
    await r.at(20_000, { rank: null });
    const v = r.eng.roundVerdict(r.m);
    const delay = r.eng._cadence(20_000, r.m);
    r.done();
    if (v.reason !== 'uncapped_no_evidence') return `HARNESS: verdict ${v.verdict}/${v.reason}`;
    return delay === 13_000 ? null : `from 20,000 the next read is ${delay} ms away, expected 13,000 (half a read after the 7,500 start)`;
  });

  await H.check('pin (never zero): a read that arrives after the last-step deadline does not stop the bid - it is decided at the deadline from the last known state (uncapped and UNCERTAIN)', async () => {
    const bad = [];
    const run = async (gcOpts, offGrid) => {
      const r = H.load({ platform: 'gc', band: BAND, gc: gcOpts, walk: walkGc });
      r.seedStanding(0, 2);
      await r.at(60_000, { rank: 2 });
      if (offGrid) await r.extend(200_000, 260_000, { rank: 2 });
      await r.at(20_000, { rank: 2 });
      const armedAt = r.m._walkClockAtMs;
      const v = r.eng.roundVerdict(r.m);
      // The next read hangs past the deadline; the fallback fires on the clock while it is still pending.
      r.ctrl.readDefer = true;
      H.setNow(r.close - 9_000);
      const pending = r.eng._tick(r.m);
      for (let i = 0; i < 20 && !r.ctrl.releaseRead; i++) await new Promise((res) => setImmediate(res));
      H.setNow(r.close - 7_500);
      if (typeof r.eng._walkClockFire === 'function') await r.eng._walkClockFire(r.m);
      const duringRead = r.trace();
      if (r.ctrl.releaseRead) r.ctrl.releaseRead();
      H.setNow(r.close - 2_000);
      await pending;
      r.done();
      return { armedAt, duringRead, v };
    };
    const unc = await run({ roundPolicy: { finalAfterExtensions: null } }, false);
    if (unc.armedAt !== 7_500) bad.push(`uncapped: the fallback was armed for ${unc.armedAt}, expected 7,500 (land 6,000 + safety 1,500)`);
    if (!H.same(unc.duringRead, [`${53_600}@7500`])) bad.push(`uncapped: while the read hung past the deadline walk on sent ${JSON.stringify(unc.duringRead)}, expected the next price 53600 at 7,500`);
    const og = await run({ roundPolicy: { finalAfterExtensions: 3 } }, true);
    if (og.v.verdict !== 'UNCERTAIN') bad.push(`HARNESS: off-grid verdict ${og.v.verdict}`);
    if (!H.same(og.duringRead, [`${G2}@7500`])) bad.push(`UNCERTAIN: while the read hung past the deadline walk on sent ${JSON.stringify(og.duringRead)}, expected the lowest ${G2} at 7,500`);
    // Rank 1 still holds, and the fallback fires once per round.
    const r1 = H.load({ platform: 'gc', band: BAND, gc: { roundPolicy: { finalAfterExtensions: null } }, walk: walkGc });
    r1.seedStanding(0, 2);
    await r1.at(20_000, { rank: 1 });
    H.setNow(r1.close - 7_500);
    if (typeof r1.eng._walkClockFire === 'function') { await r1.eng._walkClockFire(r1.m); await r1.eng._walkClockFire(r1.m); }
    r1.done();
    if (r1.writes.length) bad.push(`at rank 1 the fallback sent ${JSON.stringify(r1.trace())}`);
    return bad.join('; ') || null;
  });

  H.finish('T9 walk GoComet final round', EXPECTED);
})().catch((e) => { console.log(`FAIL harness threw: ${e && e.stack ? e.stack : e}`); process.exitCode = 1; });
