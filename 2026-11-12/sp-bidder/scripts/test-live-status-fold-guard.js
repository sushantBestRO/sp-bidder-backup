'use strict';
/**
 * LS-1: the last-resort notice is folded into the status bubble only when the bubble actually says it.
 *
 * _deliverGroup suppresses the separate "Final bid placed" notice when its bubble edit returns ok. The
 * bubble prints the final-bid line only when the LAST logged bid is the marked one, but markBubbleFinal
 * marks the most recent entry at the floor price, which need not be the last. With an earlier floor-price
 * entry followed by a higher one, and this bid's own log line never appended (its per-rung dedupe key
 * already spent, as after a re-price re-uses a rung index), the edit succeeds, carries no final line, and
 * the notice is dropped: the desk gets no statement of the final bid at all.
 *
 * Also pinned: an edit that fails (res.ok false) never counts as the statement.
 *
 *   node scripts/test-live-status-fold-guard.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ls-fold-'));

const { toRecipientRows } = require('../src/model/project');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier } = require('../src/notify/notifier');
const { notifyEngineEvent } = require('../src/notify/engineAlerts');
const { fmtNum } = require('../src/notify/waTemplates');
const { BidLogger } = require('../src/logging/bidLogger');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { MemoryStore } = require('../src/store');

let pass = 0, fail = 0;
const check = (n, cond, msg) => {
  if (cond) { pass++; console.log(`  PASS ${n}. ${msg}`); } else { fail++; console.log(`  FAIL ${n}. ${msg}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GROUP = '120363555555555555@g.us';
const customers = [{ customerId: 'havells', label: 'Havells', aliases: ['Havells'] }];
const people = [{ personId: 'g1', name: 'Bids group', phone: GROUP, alertPrefs: 'all', enabled: true }];
const assignments = [{ assignmentId: 'a1', personId: 'g1', customerId: 'havells', enabled: true }];
const BAND = { cost: 50000, marginsPct: [14, 11.5, 11.2], minMarginPct: 11.2 };
const LANE = { origin: 'Alwar', destination: 'Bhiwandi' };

async function lastResort(id, { seedBids = () => [], spendBidLiveKey = false, editsFail = false } = {}) {
  const calls = [];
  let armedEditFailure = false;
  const tr = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    if (armedEditFailure && body.type === 'edit') {
      return { ok: true, status: 200, json: async () => ({ success: false, message: 'edit refused' }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'mid-' + calls.length } }) };
  };
  const store = new MemoryStore();
  const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '128023', transport: tr });
  const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store,
    recipientsProvider: async () => toRecipientRows(customers, people, assignments) });
  const logger = new BidLogger({ store: new MemoryStore() });
  const load = { lane: LANE, companyName: 'Havells', units: 1, equipment: 'Trailer', closesAt: Date.now() + 3000 };
  const request = { id: 'rq-' + id, loadId: id, load,
    price: { cost: BAND.cost, marginsPct: BAND.marginsPct, minMarginPct: BAND.minMarginPct }, capturedAt: Date.now() };
  await n.requestPrice(request);
  await n.confirmSubmitted(request);
  const f = path.join(os.tmpdir(), `ls-fold-${id}-${process.pid}.json`);
  const events = []; const chain = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'soft' }),
    ensureSession: async () => ({}), writeEnabled: true,
    async getAuctionState() { return { ok: true, status: 'live', myRank: 4, totalBidders: 9, standingL1Price: null,
      closesInMs: 1200, revisionLimit: 3, revisionsLeft: 1, minDecrement: 100, closeModel: 'soft', measuredRttMs: 50 }; },
    async placeBid() { return { accepted: true, myRank: 9, revisionsLeft: 0, latencyMs: 20 }; },
  };
  const onEvent = (e) => {
    events.push(e);
    chain.push(logger.handle(e).then(() => notifyEngineEvent(n, e, null, (x) => logger.getRecord(x))).catch(() => {}));
  };
  const eng = new BidEngine(adapter, new DurableScheduler(f), { config: { openAtMs: 25000, floorWindowMs: 2500, minInterFireMs: 0 },
    rand: () => 0, onEvent, softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 } });
  const m = eng.arm({ id, lane: LANE, units: 1, companyName: 'Havells', closesAt: Date.now() + 3000 }, BAND);
  const floor = m.ladder[m.ladder.length - 1];
  const doc = await store.getDocAsync('askThreads', id);
  doc.groups.forEach((g) => {
    g.bids = seedBids(floor).map((b) => Object.assign({ ts: Date.now() - 60000 }, b));
    g.bidCount = g.bids.length;
  });
  await store.putDocAsync('askThreads', id, doc);
  if (spendBidLiveKey) {
    const key = `${id}_bid_live_${m.ladder.length - 1}`;
    await store.putDoc('notifSent', key, { key, kind: 'bid_live', at: Date.now() - 60000 });
  }
  armedEditFailure = editsFail;
  const before = calls.length;
  m.closeModel = 'soft'; m.extendCap = 3; m.extendsObserved = 0;
  m.currentRungIndex = 1; m.firedRungs.add(0); m.firedRungs.add(1);
  m.landedBids = 2; m.lastBidPrice = m.ladder[1]; m.revisionsLeft = 1;
  await eng._tick(m); if (m.timer) clearTimeout(m.timer);
  eng.kill(); try { fs.unlinkSync(f); } catch (_) { /* best effort */ }
  await Promise.all(chain); await sleep(30); await Promise.all(chain);
  const after = calls.slice(before);
  const edits = after.filter((b) => b.type === 'edit');
  return {
    floor,
    lastResortEvents: events.filter((e) => e.type === 'alert' && e.kind === 'last_resort_floor_fired').length,
    notices: after.filter((b) => b.type === 'text' && /Final bid placed/.test(b.message || '')),
    lastEdit: edits.length ? edits[edits.length - 1].message : '',
  };
}

(async () => {
  // ---- 1-3. The marked entry is not the last one in the bubble: the notice must still go ----
  {
    const r = await lastResort('26092501', { seedBids: (fl) => [{ price: fl, rank: 5 }, { price: fl + 2000, rank: 3 }], spendBidLiveKey: true });
    if (r.lastResortEvents !== 1) throw new Error(`setup: expected one last-resort release, got ${r.lastResortEvents}`);
    const bubbleSays = /Final bid/.test(r.lastEdit);
    check(1, !bubbleSays, `fixture: the bubble's last line is the later, higher bid, so it carries no final-bid line (${JSON.stringify(r.lastEdit.split('\n').slice(0, 3))})`);
    check(2, r.notices.length === 1,
      `the final bid is still stated once, as the notice under the ask (got ${r.notices.length} notice(s))`);
    const money = fmtNum(r.floor);
    check(3, r.notices.length === 1 && r.notices[0].message.includes(money) && !!r.notices[0].reply_to,
      `the notice names the final price ${money} and threads under the ask`);
  }

  // ---- 4. Control: the ordinary fold still takes the notice's place ----
  {
    const r = await lastResort('26092502');
    check(4, /Final bid/.test(r.lastEdit) && r.notices.length === 0,
      `with the bid logged last, the bubble says "Final bid" and no notice goes (notices ${r.notices.length})`);
  }

  // ---- 5. A failed bubble edit is never the statement ----
  {
    const r = await lastResort('26092503', { editsFail: true });
    check(5, r.notices.length === 1,
      `the bubble edit is refused, so the notice goes as before (got ${r.notices.length} notice(s))`);
  }

  const EXPECTED_CHECKS = 5;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (pass + fail !== EXPECTED_CHECKS) {
    console.log(`FAIL - expected ${EXPECTED_CHECKS} checks to run, got ${pass + fail}`);
    process.exit(1);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL (threw):', e && e.stack || e); process.exit(1); });
