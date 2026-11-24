'use strict';
/**
 * ONE LOAD'S LIFECYCLE STAYS IN ONE GROUP.
 *
 * This is the product invariant behind BOTH #71 (a branch gets its own WhatsApp group) and #75 (the
 * ask -> status bubble -> outcome thread). Each of those was tested on its own; the SEAM between
 * them was not, and that is exactly where the 2026-07-25 blackout happened: 13 `bid_live` alerts
 * reached nobody in a 43-minute window on Havells Alwar loads, during the engine's first live
 * soft-close defends.
 *
 * The mechanism. Group matching keys on `data.branch` (notifier.scopeMatches -> branchMatches), and
 * an ABSENT branch is deliberately never a match. The ASK carries `branch` (notifier builds it off
 * the load snapshot), but the ENGINE-emitted payloads did not - so the ask anchored on the Alwar
 * group while every later `bid_live` resolved to the GENERAL Havells group, found no ask thread
 * there, and was deliberately skipped. Same gap sent won/lost to the general group, splitting one
 * load's lifecycle across two groups.
 *
 * scripts/test-branch-group-routing.js proves branchKey / branchMatches / applyBranchPrecedence as
 * UNITS against hand-built recipient rows. It cannot catch this, because it never asserts that the
 * payloads the engine actually emits carry the key those functions read. This file closes that seam:
 * it drives the REAL lifecycle in order through the REAL notifier and asserts every wire call for
 * one load landed on ONE jid. Any future alert kind that forgets a routing key fails here rather
 * than in production.
 */

const { toRecipientRows } = require('../src/model/project');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier } = require('../src/notify/notifier');
const { notifyEngineEvent } = require('../src/notify/engineAlerts');
const { MemoryStore } = require('../src/store');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

function mockTransport() {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'mid-' + calls.length } }) };
  };
  fn.calls = calls;
  return fn;
}

const HAVELLS_GROUP = '120363111111111111@g.us';        // general - every Havells branch
const HAVELLS_ALWAR_GROUP = '120363222222222222@g.us';  // branch-scoped - Alwar only
const DURIAN_GROUP = '120363444444444444@g.us';         // a customer with NO branch group at all

const ALWAR_LABEL = 'Alwar Cable (1350)';               // the RAW SP branch label
const LOAD_ID = '23494797';                             // the live load from the incident

const customers = [
  { customerId: 'havells', label: 'Havells', aliases: ['Havells'] },
  { customerId: 'durian', label: 'Durian', aliases: ['Durian'] },
];
const people = [
  { personId: 'g1', name: 'BRL Bids - Havells', phone: HAVELLS_GROUP, alertPrefs: 'all', enabled: true },
  { personId: 'g2', name: 'BRL Bids - Havells Alwar', phone: HAVELLS_ALWAR_GROUP, alertPrefs: 'all', enabled: true, branchScope: [ALWAR_LABEL] },
  { personId: 'g3', name: 'BRL Bids - Durian', phone: DURIAN_GROUP, alertPrefs: 'all', enabled: true },
];
const assignments = [
  { assignmentId: 'a1', personId: 'g1', customerId: 'havells', enabled: true },
  { assignmentId: 'a2', personId: 'g2', customerId: 'havells', enabled: true },
  { assignmentId: 'a3', personId: 'g3', customerId: 'durian', enabled: true },
];

/**
 * Drive one load through its FULL lifecycle in the real order, returning the jids each phase hit.
 *
 * The order matters and is the production one: the ask anchors the thread, the receipt creates the
 * status bubble, `bid_live` edits that bubble, and the outcome replies under the pristine ask. A
 * `bid_live` whose group has no ask thread is deliberately skipped (it must never mint a fresh
 * per-bid ping - #75), so a MISROUTED bid_live shows up here as ZERO sends, not as a wrong jid.
 *
 * rungIndex 1 (a step-down, not the establishing rung) is the incident's own shape: it strips every
 * DM recipient, which is what removed the last fallback and made the misroute reach nobody at all.
 */
async function runLifecycle({ companyName, branchName, rungIndex }) {
  const tr = mockTransport();
  const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '128023', transport: tr });
  const n = new Notifier({
    mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
    recipientsProvider: async () => toRecipientRows(customers, people, assignments),
  });

  const lane = { origin: 'Alwar', destination: 'Camp Khordha' };
  const load = { lane, companyName, branchName, closesAt: 1751000000000 };
  const request = {
    id: 'rq-' + LOAD_ID, loadId: LOAD_ID, load,
    price: { cost: 84000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 },
    capturedAt: 1750000000000,
  };

  const phase = async (fn) => {
    const before = tr.calls.length;
    await fn();
    return tr.calls.slice(before).map((c) => c.body.to_number);
  };

  const ask = await phase(() => n.requestPrice(request));
  const receipt = await phase(() => n.confirmSubmitted(request));
  const bidLive = await phase(() => notifyEngineEvent(n, {
    type: 'bid_placed', auctionId: LOAD_ID, price: 94080, rungIndex, socketRank: 2,
    lane, companyName, branchName, cost: 84000, openingPct: 12.6,
  }));
  const outcome = await phase(() => notifyEngineEvent(n, {
    type: 'auction_result', auctionId: LOAD_ID, won: true, finalRank: 1,
    lane, companyName, branchName, landedBids: 1,
  }));

  return { ask, receipt, bidLive, outcome, all: tr.calls.map((c) => c.body.to_number) };
}

(async () => {
  // ---- THE INVARIANT: a branch-split customer's whole lifecycle lands on the branch jid ----
  {
    const r = await runLifecycle({ companyName: 'Havells', branchName: ALWAR_LABEL, rungIndex: 1 });

    // Each phase must actually reach the group. A silent skip is the failure mode under test:
    // "zero sends" is precisely how the live blackout presented, so an empty phase is a FAIL.
    ok(r.ask.length === 1, `the price ask reaches exactly one group (got ${r.ask.length})`);
    ok(r.receipt.length === 1, `the submit receipt reaches exactly one group (got ${r.receipt.length})`);
    ok(r.bidLive.length === 1, `bid_live reaches exactly one group - a misrouted bid_live is SKIPPED, reaching nobody (got ${r.bidLive.length})`);
    ok(r.outcome.length === 1, `the outcome reaches exactly one group (got ${r.outcome.length})`);

    // ONE jid for the whole load - the actual product requirement.
    const distinct = [...new Set(r.all)];
    ok(distinct.length === 1,
      `one load's lifecycle stays in ONE group - ask/receipt/bid_live/outcome must share a jid (got ${distinct.length}: ${distinct.join(', ')})`);
    ok(distinct[0] === HAVELLS_ALWAR_GROUP,
      `that one group is the BRANCH group, not the general one (got ${distinct[0]})`);
    ok(!r.all.includes(HAVELLS_GROUP),
      'the general Havells group receives NOTHING for an Alwar load - no half of the lifecycle leaks across');

    // Name the two halves explicitly, so a regression says WHICH seam broke rather than just "not one jid".
    ok(r.bidLive[0] === r.ask[0], 'bid_live resolves to the same jid the ask anchored on (the status bubble is reachable)');
    ok(r.outcome[0] === r.ask[0], 'the outcome replies in the same group the ask anchored on (won/lost do not split off)');
  }

  // ---- BACKWARD-COMPAT: a customer with NO branch group is byte-identical ----
  // The control case from the incident: Durian has no branch group, and its bid_live logged fine
  // throughout the outage. Blank-when-absent must keep it that way.
  {
    const r = await runLifecycle({ companyName: 'Durian', branchName: undefined, rungIndex: 1 });
    ok(r.ask.length === 1 && r.ask[0] === DURIAN_GROUP, 'branch-less customer: the ask reaches its single group');
    ok(r.receipt.length === 1 && r.receipt[0] === DURIAN_GROUP, 'branch-less customer: the receipt reaches its single group');
    ok(r.bidLive.length === 1 && r.bidLive[0] === DURIAN_GROUP, 'branch-less customer: bid_live still reaches its group (unchanged by the branch carry)');
    ok(r.outcome.length === 1 && r.outcome[0] === DURIAN_GROUP, 'branch-less customer: the outcome still reaches its group');
    ok([...new Set(r.all)].length === 1, 'branch-less customer: the whole lifecycle stays in one group, exactly as before');
  }

  // ---- a branch-carrying load whose customer has NO branch group still routes to the general group ----
  // Guards the other direction: carrying `branch` on engine payloads must not make a load MISS the
  // only group it has (Durian loads do carry SP branch labels).
  {
    const r = await runLifecycle({ companyName: 'Durian', branchName: 'Durian TN (7788)', rungIndex: 1 });
    ok([...new Set(r.all)].length === 1 && r.all[0] === DURIAN_GROUP,
      'a branch LABEL on a customer with no branch GROUP routes to the general group unchanged (branch is a filter, never a requirement)');
    ok(r.bidLive.length === 1, 'that customer bid_live is unaffected by the branch label');
  }

  // ---- the establishing rung (0) keeps its DM ping AND the group line ----
  // rungIndex 0 does not strip DMs, so this asserts the branch carry did not disturb the rung-0 path.
  {
    const r = await runLifecycle({ companyName: 'Havells', branchName: ALWAR_LABEL, rungIndex: 0 });
    ok(r.bidLive.length === 1 && r.bidLive[0] === HAVELLS_ALWAR_GROUP,
      'the establishing rung also lands on the branch group (no group has a DM sibling here, so it stays one send)');
  }

  // ---- SKIP is not a send FAILURE, and bid_live is never silent ----
  // Even with routing correct, bid_live has no fallback of its own: the rungIndex > 0 filter strips
  // every DM, and _deliverGroup skips a group with no ask thread / no status bubble. A genuinely
  // bubble-less load therefore reaches nobody with no bug in play. These pin the reporting split and
  // the backstop.
  {
    // A group-only customer, an ask on the group, but NO receipt - so no status bubble exists.
    const tr = mockTransport();
    const logged = [];
    const log = Object.assign(() => {}, {
      debug: (m, meta) => logged.push({ level: 'debug', m, meta }),
      info: (m, meta) => logged.push({ level: 'info', m, meta }),
      warn: (m, meta) => logged.push({ level: 'warn', m, meta }),
      error: (m, meta) => logged.push({ level: 'error', m, meta }),
    });
    const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '128023', transport: tr });
    const n = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log, wa, store: new MemoryStore(),
      recipientsProvider: async () => toRecipientRows(customers, people, assignments),
    });
    const lane = { origin: 'Alwar', destination: 'Camp Khordha' };
    const load = { lane, companyName: 'Havells', branchName: ALWAR_LABEL, closesAt: 1751000000000 };
    await n.requestPrice({ id: 'rq-nb', loadId: 'L-NOBUBBLE', load });
    const before = tr.calls.length;
    await notifyEngineEvent(n, {
      type: 'bid_placed', auctionId: 'L-NOBUBBLE', price: 94080, rungIndex: 1, socketRank: 2,
      lane, companyName: 'Havells', branchName: ALWAR_LABEL,
    });
    const sends = tr.calls.slice(before);

    ok(sends.length === 1 && sends[0].body.to_number === HAVELLS_ALWAR_GROUP,
      `a bubble-less bid_live degrades to a fresh group message instead of silence (got ${sends.length} send(s))`);

    const nobody = logged.filter((l) => l.meta && l.meta.reachedNobody);
    ok(nobody.length === 0, 'a deliberate skip is NOT reported as "reached NOBODY" - nothing failed on the wire');
    const skipInfo = logged.filter((l) => l.level === 'info' && l.meta && l.meta.allSkipped);
    ok(skipInfo.length === 1, 'the all-skipped outcome is logged at INFO, once');
    ok(skipInfo.length === 1 && /no status bubble for bid_live/.test(String(skipInfo[0].meta.reason)),
      'the INFO line names the actual skip REASON, so the outcome is self-describing');
    ok(logged.some((l) => l.level === 'warn' && l.meta && l.meta.backstop), 'the backstop degrade is announced at warn');
  }

  {
    // A genuine wire failure must KEEP the error + reachedNobody wording. The lifecycle is built
    // successfully FIRST (ask + bubble both land), then the wire breaks - so the bid_live below is a
    // real attempted-and-rejected send, not a skip.
    let broken = false;
    const tr = mockTransport();
    const gated = Object.assign(async (url, opts) => {
      if (broken) return { ok: false, status: 500, json: async () => ({}) };
      return tr(url, opts);
    }, { calls: tr.calls });
    const logged = [];
    const log = Object.assign(() => {}, {
      debug: () => {}, info: (m, meta) => logged.push({ level: 'info', m, meta }),
      warn: (m, meta) => logged.push({ level: 'warn', m, meta }),
      error: (m, meta) => logged.push({ level: 'error', m, meta }),
    });
    const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '128023', transport: gated });
    const n = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log, wa, store: new MemoryStore(),
      recipientsProvider: async () => toRecipientRows(customers, people, assignments),
    });
    const lane = { origin: 'Alwar', destination: 'Camp Khordha' };
    const load = { lane, companyName: 'Havells', branchName: ALWAR_LABEL, closesAt: 1751000000000 };
    const request = { id: 'rq-f', loadId: 'L-FAIL', load, price: { cost: 84000, marginsPct: [12.6], minMarginPct: 6.3 }, capturedAt: 1750000000000 };
    await n.requestPrice(request);
    await n.confirmSubmitted(request);      // bubble now exists, so bid_live will genuinely try to edit it
    broken = true;
    await notifyEngineEvent(n, {
      type: 'bid_placed', auctionId: 'L-FAIL', price: 94080, rungIndex: 1, socketRank: 2,
      lane, companyName: 'Havells', branchName: ALWAR_LABEL,
    });
    ok(logged.some((l) => l.level === 'error' && l.meta && l.meta.reachedNobody),
      'a REAL send failure still reports error + reachedNobody (the wording is reserved, not removed)');
    ok(!logged.some((l) => l.level === 'info' && l.meta && l.meta.allSkipped),
      'a real failure is never mislabelled as a deliberate skip');
    ok(!logged.some((l) => l.level === 'warn' && l.meta && l.meta.backstop),
      'the backstop does NOT fire on a real failure - a fresh send to a jid that just failed would fail the same way');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
