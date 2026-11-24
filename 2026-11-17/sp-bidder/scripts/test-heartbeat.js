'use strict';
/**
 * Daily morning heartbeat (src/notify/heartbeat.js), offline. Exercises the IST
 * time math (fixed +05:30, injectable now), each section collector against a
 * MemoryStore + fake stacks, the renderer's verdict/issue/note contract (verdict
 * first line, ASCII-only, no label noise on a single account), recipient
 * resolution (explicit list -> person ids/phones; default -> every person whose
 * name matches any comma-separated fragment, deduped, never a group), and the
 * fail-quiet-loud send path: a broken gather still sends
 * a degraded message, a failed send never writes sentDate (so the boot catch-up
 * can retry), and the catch-up itself dedupes on sentDate.
 */

const {
  COLLECTION, STATE_KEY,
  istMidnight, istDayStamp, istDisplayDate, parseTimeIST, nextRunAt,
  collectAccounts, collectSender, collectFunnel, collectToday, collectServer,
  fmtSize, fmtUptime,
  renderHeartbeat, resolveRecipients, runHeartbeat, startDailyHeartbeat,
} = require('../src/notify/heartbeat');
const { Notifier } = require('../src/notify/notifier');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { MemoryStore } = require('../src/store');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const DAY = 86400000;
// Fixed reference instant: 08:00 IST on Thu 16 Jul 2026 (02:30 UTC).
const NOW = Date.UTC(2026, 6, 16, 2, 30);
const TODAY_MID = Date.UTC(2026, 6, 15, 18, 30);      // 00:00 IST, 16 Jul
const YESTERDAY_MID = TODAY_MID - DAY;                // 00:00 IST, 15 Jul

// The SOURCE stays ASCII (the emoji live in the template as unicode escapes); the
// RENDERED message may carry exactly the deliberate emoji set below and nothing else
// non-ASCII. Sparse rule under test: a handful per message, section anchors only,
// never one per data line, and the closing italic line stays emoji-free.
const EMOJI = ['\u{2705}', '\u{26A0}\u{FE0F}', '\u{1F4CA}', '\u{1F4C5}', '\u{1F4C8}', '\u{1F4C9}'];
const stripEmoji = (s) => EMOJI.reduce((x, e) => x.split(e).join(''), s);
const asciiButEmoji = (s) => /^[\x20-\x7E\n]*$/.test(stripEmoji(s));
const emojiCount = (s) => EMOJI.reduce((n, e) => n + s.split(e).length - 1, 0);

// A stack shaped like server.js builds them, reduced to what the collectors read.
function fakeStack(accountId, label, branchIds, tokenExp) {
  return { account: { accountId, label }, adapter: { account: { branchIds, tokenExp } } };
}
function fakeRequests(docs) { return { listAll: async () => docs }; }
function fakePersonStore(people) {
  return {
    list: async () => people,
    get: async (id) => people.find((p) => p.personId === id) || null,
  };
}
function fakeNotifier() {
  const sends = [];
  return {
    sends,
    sendDirect: async (phone, message, opts) => { sends.push({ phone, message, opts }); return { ok: true, messageId: 'hb-' + sends.length }; },
  };
}
// All-green sections for renderer tests; override per case.
function greenSections(over = {}) {
  return Object.assign({
    accounts: { ok: true, expectedCount: 1, liveCount: 1, totalBranches: 17, branchCounts: { primary: 17 }, changes: [], tokenSoonest: { exp: NOW + 300 * DAY, label: 'Primary' } },
    sender: { ok: true, configured: true, healthy: true, mode: 'whatsapp' },
    funnel: { ok: true, discovered: 12, priced: 9, missedCutoff: 3, declined: 0, bidsPlaced: 7, loadsBid: 5, rejected: 0, won: 2, lost: 3 },
    today: { ok: true, armedToday: 2, armedLater: 1, awaiting: 1 },
  }, over);
}

(async () => {
  // ---- IST time math ----
  {
    ok(istMidnight(NOW) === TODAY_MID, '08:00 IST resolves to that IST day\'s midnight');
    // 23:30 IST on the 15th is 18:00 UTC on the 15th - still the 15th in IST.
    ok(istMidnight(Date.UTC(2026, 6, 15, 18, 0)) === YESTERDAY_MID, 'late-IST-evening instant stays on its IST day');
    // 00:30 IST on the 16th is 19:00 UTC on the 15th - already the 16th in IST.
    ok(istMidnight(Date.UTC(2026, 6, 15, 19, 0)) === TODAY_MID, 'just-past-IST-midnight instant rolls to the new IST day');
    ok(istDayStamp(NOW) === '2026-07-16', 'day stamp is the IST date');
    ok(istDisplayDate(NOW) === 'Thu 16 Jul', 'display date is ASCII day + date + month');

    ok(JSON.stringify(parseTimeIST('08:00')) === JSON.stringify({ h: 8, m: 0 }), 'parses HH:MM');
    ok(JSON.stringify(parseTimeIST('6:45')) === JSON.stringify({ h: 6, m: 45 }), 'parses H:MM');
    ok(JSON.stringify(parseTimeIST('25:00')) === JSON.stringify({ h: 8, m: 0 }), 'out-of-range hour falls back to 08:00 (degrade, never disable)');
    ok(JSON.stringify(parseTimeIST('garbage')) === JSON.stringify({ h: 8, m: 0 }), 'unparseable falls back to 08:00');

    const eight = { h: 8, m: 0 };
    ok(nextRunAt(NOW - 3600000, eight) === NOW, 'an hour before the slot -> today\'s slot');
    ok(nextRunAt(NOW, eight) === NOW + DAY, 'exactly at the slot -> tomorrow (a fire at t never reschedules to t)');
    ok(nextRunAt(NOW + 60000, eight) === NOW + DAY, 'past the slot -> tomorrow');
  }

  // ---- collectAccounts: expected-vs-live, branch totals + diffs, soonest token ----
  {
    const store = new MemoryStore(); // empty accounts collection -> one implicit primary expected
    const stacks = [fakeStack('primary', 'Primary', [1, 2, 3], NOW + 200 * DAY)];
    const a = await collectAccounts({ stacks, store, state: { branchCounts: { primary: 2 } } });
    ok(a.ok && a.expectedCount === 1 && a.liveCount === 1, 'implicit primary: 1 expected, 1 live');
    ok(a.totalBranches === 3, 'branch total summed from the live adapter identity');
    ok(a.changes.length === 1 && a.changes[0].from === 2 && a.changes[0].to === 3, 'branch-count change vs the last run\'s state is surfaced');
    ok(a.tokenSoonest && a.tokenSoonest.exp === NOW + 200 * DAY, 'soonest token expiry captured');
  }
  {
    // Two enabled account records but only one live stack - the boot path drops a
    // failed-login account from `stacks` entirely, so counting stacks alone would
    // report a healthy 1-of-1; the accounts collection is the source of "should be".
    const store = new MemoryStore();
    await store.putDoc('accounts', 'primary', { accountId: 'primary', tokenEnv: 'SP_TOKEN' });
    await store.putDoc('accounts', 'acct2', { accountId: 'acct2', tokenEnv: 'SP_TOKEN_2' });
    const a = await collectAccounts({ stacks: [fakeStack('primary', 'Primary', [1], NOW + 100 * DAY)], store, state: null });
    ok(a.expectedCount === 2 && a.liveCount === 1, 'a dropped (boot-failed) account shows as expected>live');
    ok(a.changes.length === 0, 'first run (no state) reports no branch changes');
  }

  // ---- collectSender ----
  {
    const s = await collectSender({ wa: { enabled: () => false }, config: { notifyMode: 'dashboard' } });
    ok(s.ok && s.configured === false && s.healthy === null, 'unconfigured sender is reported, not treated as down');
    const s2 = await collectSender({ wa: { enabled: () => true, sessionHealthy: async () => false }, config: { notifyMode: 'whatsapp' } });
    ok(s2.configured === true && s2.healthy === false, 'a logged-out session reads as down');
    const s3 = await collectSender({ wa: { enabled: () => true, sessionHealthy: async () => { throw new Error('probe died'); } }, config: { notifyMode: 'whatsapp' } });
    ok(s3.healthy === true, 'a failing probe fails OPEN (same posture as the alert circuit breaker)');
  }

  // ---- collectFunnel: yesterday's IST-day cohort + bid/outcome windows ----
  {
    const reqDocs = [
      // yesterday's cohort: priced / missed / declined / one still awaiting
      { createdAt: YESTERDAY_MID + 1, capturedAt: YESTERDAY_MID + 2, status: 'closed' },
      { createdAt: YESTERDAY_MID + 3, capturedAt: null, status: 'skipped_no_price' },
      { createdAt: YESTERDAY_MID + 4, capturedAt: null, status: 'dismissed' },
      { createdAt: YESTERDAY_MID + 5, capturedAt: null, status: 'awaiting_price' },
      // boundary guards: created the day BEFORE yesterday, and created today
      { createdAt: YESTERDAY_MID - 1, capturedAt: YESTERDAY_MID - 1, status: 'closed' },
      { createdAt: TODAY_MID + 1, capturedAt: null, status: 'awaiting_price' },
    ];
    const store = new MemoryStore();
    // two bids yesterday on one load (won yesterday), one bid today on another (still open),
    // one rejection yesterday, one closed-no-bid yesterday, one closed outside the window
    await store.putDoc('closedBids', 'A', { auctionId: 'A', status: 'closed', won: true, closedAt: YESTERDAY_MID + 9, ourBids: [{ price: 1, ts: YESTERDAY_MID + 6 }, { price: 2, ts: YESTERDAY_MID + 7 }] });
    await store.putDoc('closedBids', 'B', { auctionId: 'B', status: 'open', won: null, closedAt: null, ourBids: [{ price: 3, ts: TODAY_MID + 5 }] });
    await store.putDoc('closedBids', 'C', { auctionId: 'C', status: 'closed', won: false, closedAt: YESTERDAY_MID + 10, ourBids: [], rejectedBids: [{ price: 4, ts: YESTERDAY_MID + 8 }] });
    await store.putDoc('closedBids', 'D', { auctionId: 'D', status: 'closed', won: true, closedAt: YESTERDAY_MID - 5, ourBids: [] });
    const f = await collectFunnel({ requests: fakeRequests(reqDocs), store, now: NOW });
    ok(f.discovered === 4, `cohort = requests created on the IST yesterday only (got ${f.discovered})`);
    ok(f.priced === 1 && f.missedCutoff === 1 && f.declined === 1, 'priced / missed-cutoff / declined split from the cohort');
    ok(f.bidsPlaced === 2 && f.loadsBid === 1, `bids counted by ts window, loads deduped (got ${f.bidsPlaced}/${f.loadsBid})`);
    ok(f.rejected === 1, 'portal rejections in the window counted');
    // 'C' closed yesterday having never bid, so it is no_bid and lands in no outcome bucket.
    ok(f.won === 1 && f.lost === 0, `outcomes keyed off closedAt, not the request cohort (got ${f.won}/${f.lost})`);
  }

  // ---- collectFunnel: an unseen close is its own class, never a loss ----
  // A record retired by the restart sweep or by _retireUnreadable carries landed bids and no final
  // rank, which is byte-identical to a fought loss - and this collector applied the binary rule, so
  // every orphan landed in `lost` on the message the client's Director reads each morning. Nothing
  // produced that shape until the sweep existed, which is why the blind spot was unreachable before.
  {
    const store = new MemoryStore();
    const bids = [{ price: 56300, ts: YESTERDAY_MID + 6 }];
    await store.putDoc('closedBids', 'U1', { auctionId: 'U1', status: 'closed', won: null, finalRank: null, closedWhileDown: true, closedAt: YESTERDAY_MID + 9, ourBids: bids });
    await store.putDoc('closedBids', 'L1', { auctionId: 'L1', status: 'closed', won: false, finalRank: 4, closedAt: YESTERDAY_MID + 9, ourBids: bids });
    // The one flagged record that IS settled: rehydrate preserves a rank when the record had one,
    // and a preserved rank is a real outcome. Both halves of the rule are load-bearing here too.
    await store.putDoc('closedBids', 'L2', { auctionId: 'L2', status: 'closed', won: false, finalRank: 3, closedWhileDown: true, closedAt: YESTERDAY_MID + 9, ourBids: bids });
    await store.putDoc('closedBids', 'W1', { auctionId: 'W1', status: 'closed', won: true, finalRank: 1, closedAt: YESTERDAY_MID + 9, ourBids: bids });
    // ZERO BIDS OUTRANKS EVERY OTHER TEST. The canonical rule (exportModel.deriveStatus) asks
    // "did we bid?" FIRST and answers no_bid - a class this message does not carry at all. A load
    // armed and retired before its first rung carries the flag and no rank, so without the guard it
    // landed in the new unknown tally here while History, both exports, the participation report and
    // the Director's evening message all call it No-bid: one number the console cannot reconcile.
    await store.putDoc('closedBids', 'N1', { auctionId: 'N1', status: 'closed', won: null, finalRank: null, closedWhileDown: true, closedAt: YESTERDAY_MID + 9, ourBids: [] });
    const f = await collectFunnel({ requests: fakeRequests([]), store, now: NOW });
    ok(f.closedUnknown === 1,
      `an unseen close is counted as its own class (got ${f.closedUnknown})`);
    ok(f.lost === 2,
      `and is NOT charged to lost - only the fought loss and the rank-preserved one are (got ${f.lost})`);
    ok(f.won === 1, 'wins are undisturbed');
  }

  // ---- collectFunnel: a load that never bid is no_bid, and belongs to none of the three ----
  {
    const store = new MemoryStore();
    // Retired without a bid: flagged and rankless, the shape the unknown branch matches on.
    await store.putDoc('closedBids', 'N1', { auctionId: 'N1', status: 'closed', won: null, finalRank: null, closedWhileDown: true, closedAt: YESTERDAY_MID + 9, ourBids: [] });
    // Closed without a bid and without the flag: the plain no_bid, which the binary rule charged
    // to `lost` long before the unknown class existed.
    await store.putDoc('closedBids', 'N2', { auctionId: 'N2', status: 'closed', won: false, finalRank: null, closedAt: YESTERDAY_MID + 9, ourBids: [] });
    const f = await collectFunnel({ requests: fakeRequests([]), store, now: NOW });
    ok(f.closedUnknown === 0, `a load that never bid is not an unseen close (got ${f.closedUnknown})`);
    ok(f.lost === 0, `nor a loss - nothing of ours was on the board to lose with (got ${f.lost})`);
    ok(f.won === 0, 'and certainly not a win');
  }

  // ---- renderer: the unknown class is stated, not folded into won or lost ----
  {
    const msg = renderHeartbeat(greenSections({
      funnel: { ok: true, discovered: 12, priced: 9, missedCutoff: 0, declined: 0, bidsPlaced: 7, loadsBid: 5, rejected: 0, won: 2, lost: 3, closedUnknown: 2 },
    }), NOW);
    ok(msg.includes('- Won 2, lost 3'), 'the outcomes line still reports only what it can call');
    ok(msg.includes('- Closed without a result we could see - 2'),
      'and the unseen closes get their own line rather than vanishing between the two numbers');
    ok(asciiButEmoji(msg), 'the added line keeps the message ASCII outside the deliberate emoji set');
    const quiet = renderHeartbeat(greenSections({
      funnel: { ok: true, discovered: 0, priced: 0, missedCutoff: 0, declined: 0, bidsPlaced: 0, loadsBid: 0, rejected: 0, won: 0, lost: 0, closedUnknown: 2 },
    }), NOW);
    ok(!quiet.includes('no bidding activity'),
      'a day whose only closes were unseen is not reported as "no bidding activity"');
    const zero = renderHeartbeat(greenSections({
      funnel: { ok: true, discovered: 12, priced: 9, missedCutoff: 0, declined: 0, bidsPlaced: 7, loadsBid: 5, rejected: 0, won: 2, lost: 3, closedUnknown: 0 },
    }), NOW);
    ok(!zero.includes('Closed without a result'), 'with none, the line is absent - no zero row on a clean day');
  }

  // ---- collectToday: armed today vs later, still-awaiting ----
  {
    const reqDocs = [
      { status: 'armed', load: { closesAt: NOW + 3600000 } },          // closes today
      { status: 'armed', load: { closesAt: TODAY_MID + DAY + 5 } },    // closes tomorrow
      { status: 'armed', load: { closesAt: NOW - 5 } },                // already closed - not "ready"
      { status: 'awaiting_price', load: { closesAt: NOW + 7200000 } },
      { status: 'closed', load: { closesAt: NOW + 100 } },
    ];
    const t = await collectToday({ requests: fakeRequests(reqDocs), now: NOW });
    ok(t.armedToday === 1 && t.armedLater === 1, `armed split into today vs later (got ${t.armedToday}/${t.armedLater})`);
    ok(t.awaiting === 1, 'still-awaiting count');
  }

  // ---- renderer: verdict-first contract, ASCII, notes, label-noise rule ----
  {
    const msg = renderHeartbeat(greenSections(), NOW);
    ok(msg.split('\n')[0] === '\u{2705} *Bid Command: all systems normal* - Thu 16 Jul', 'all-green verdict is the whole first line, check-marked');
    ok(asciiButEmoji(msg), 'rendered message is ASCII outside the deliberate emoji set');
    ok(emojiCount(msg) === 3, `sparse emoji: exactly 3 on a normal day (verdict/yesterday/today), got ${emojiCount(msg)}`);
    ok(emojiCount(msg.split('\n').pop()) === 0, 'the closing italic line stays emoji-free');
    ok(msg.includes('*Accounts* - connected, 17 branches'), 'single account renders with no N-of-M label noise');
    ok(msg.includes('*Yesterday (Wed 15 Jul)*'), 'funnel block is dated to the IST yesterday');
    ok(msg.includes('- Won 2, lost 3'), 'outcomes line present');
    ok(msg.includes('*Today* - 2 auctions armed and ready, 1 more armed for later days, 1 load still waiting for a price'), 'today line aggregates armed + waiting');
    ok(!msg.includes('expires in'), 'a far-out token gets no line (noise rule: only within 30 days)');
    ok(msg.includes('stops arriving'), 'the absence-is-the-alarm footer is present');
  }
  {
    const msg = renderHeartbeat(greenSections({ sender: { ok: true, configured: true, healthy: false, mode: 'whatsapp' } }), NOW);
    ok(msg.startsWith('\u{26A0}\u{FE0F} *Bid Command: attention needed*'), 'a down sender flips the verdict to the warning sign (never a cheerful check)');
    ok(!msg.includes('\u{2705}'), 'no green check anywhere on an attention morning');
    ok(msg.includes('- WhatsApp alerts are not being delivered'), 'the issue is spelled out under the verdict');
    ok(msg.includes('*WhatsApp alerts* - DOWN'), 'and the status line agrees');
  }
  {
    const msg = renderHeartbeat(greenSections({
      accounts: { ok: true, expectedCount: 2, liveCount: 1, totalBranches: 9, branchCounts: { primary: 9 }, changes: [], tokenSoonest: { exp: NOW + 12 * DAY, label: 'Ahmedabad' } },
    }), NOW);
    ok(msg.includes('- 1 of 2 SuperProcure accounts could not log in'), 'a missing account is an issue line');
    ok(msg.includes('(Ahmedabad) expires in 12 days'), 'a <=30d token is an issue line, labeled only on multi-account');
    ok(msg.includes('*Accounts* - 1 of 2 connected, 9 branches'), 'multi-account status line carries N of M');
  }
  {
    const msg = renderHeartbeat(greenSections({
      accounts: { ok: true, expectedCount: 1, liveCount: 1, totalBranches: 19, branchCounts: { primary: 19 }, changes: [{ accountId: 'primary', label: 'Primary', from: 17, to: 19 }], tokenSoonest: null },
    }), NOW);
    ok(msg.startsWith('\u{2705} *Bid Command: all systems normal*'), 'a branch-count change alone does NOT flip the verdict');
    ok(msg.includes('\u{1F4C8} Note - SuperProcure added 2 branches since yesterday (17 to 19)'), 'the change is called out as a chart-up note');
    ok(emojiCount(msg) === 4, `sparse emoji: a note day tops out at 4, got ${emojiCount(msg)}`);
  }
  {
    const msg = renderHeartbeat(greenSections({ funnel: { ok: false } }), NOW);
    ok(msg.startsWith('\u{26A0}\u{FE0F} *Bid Command: attention needed*'), 'an unreadable section flips the verdict (a lying "all normal" is worse than noise)');
    ok(msg.includes("could not read yesterday's bidding records"), 'the unreadable section is named in plain words');
    ok(!msg.includes('New loads found'), 'the broken section renders nothing else');
  }
  {
    const msg = renderHeartbeat(greenSections({
      funnel: { ok: true, discovered: 0, priced: 0, missedCutoff: 0, declined: 0, bidsPlaced: 0, loadsBid: 0, rejected: 0, won: 0, lost: 0 },
      today: { ok: true, armedToday: 0, armedLater: 0, awaiting: 0 },
    }), NOW);
    ok(msg.includes('*Yesterday (Wed 15 Jul)* - no bidding activity'), 'a zero day is one line, not a wall of zeros');
    ok(msg.includes('*Today* - nothing armed yet'), 'an empty today is still stated (silence is never ambiguous)');
  }

  // ---- collectServer + Server rendering (VPS health) ----
  {
    // A fake sysProbe, same read() shape as src/notify/serverHealth.js - raw numbers only, the
    // collector/renderer own the thresholds and formatting.
    const probe = (over = {}) => ({ read: async () => Object.assign({
      storage: { totalBytes: 100e9, availBytes: 62e9, usedPct: 38 },
      logsBytes: 210 * 1024 * 1024,
      rssBytes: 180 * 1024 * 1024,
      sysFreePct: 55,
      uptimeSec: 6 * 86400,
    }, over) });

    const sv = await collectServer({ sysProbe: probe(), config: { dataDir: '/x' } });
    ok(sv.ok && sv.wired && sv.storagePct === 38 && sv.rssMb === 180, 'collectServer maps probe numbers to reader facts');
    ok(sv.logsBytes === 210 * 1024 * 1024 && sv.uptimeSec === 6 * 86400 && sv.sysFreePct === 55, 'raw bytes/seconds/percent carried through for the renderer to format');
    ok(sv.memCapMb === 500, 'the PM2 memory cap is surfaced (must match ecosystem.config.cjs)');

    const noProbe = await collectServer({ sysProbe: null, config: {} });
    ok(noProbe.ok === true && noProbe.wired === false, 'no sysProbe wired -> section renders nothing, never an error');

    const partial = await collectServer({ sysProbe: probe({ storage: null, logsBytes: null }), config: {} });
    ok(partial.storagePct === null && partial.logsBytes === null && partial.rssMb === 180, 'an unreadable field (older Node / missing log dir) degrades to null, the others still read');

    // size + uptime formatting, including the null-fact passthrough
    ok(fmtSize(210 * 1024 * 1024) === '210 MB' && fmtSize(1.4 * 1024 * 1024 * 1024) === '1.4 GB', 'sizes read MB, then GB with one decimal past 1 GB');
    ok(fmtUptime(6 * 86400) === '6 days' && fmtUptime(2 * 3600) === '2 hours' && fmtUptime(90) === '2 minutes', 'uptime uses the largest sensible whole unit');
    ok(fmtUptime(3600) === '1 hour' && fmtUptime(86400) === '24 hours' && fmtUptime(2 * 86400) === '2 days', 'singular drops the plural s (1 hour); hours run up to the 2-day cutoff (24 hours), then days');
    ok(fmtSize(null) === null && fmtUptime(null) === null, 'a null fact formats to null (the renderer skips it)');

    // healthy box: one emoji-free standing line, verdict stays green, emoji budget unchanged
    const green = renderHeartbeat(greenSections({ server: sv }), NOW);
    ok(green.startsWith('\u{2705} *Bid Command: all systems normal*'), 'a healthy server does NOT flip the verdict');
    ok(green.includes('*Server* - storage 38% used, logs 210 MB, memory 180 MB, uptime 6 days'), 'the standing Server line reads storage/logs/memory/uptime, renamed for the reader');
    ok(asciiButEmoji(green), 'the Server line keeps the message ASCII outside the deliberate emoji set');
    ok(emojiCount(green) === 3, `the Server line is emoji-free - budget stays at 3 on a normal day, got ${emojiCount(green)}`);

    // unhealthy box: storage + logs + memory + system RAM all cross their thresholds -> issues, verdict flips
    const sick = await collectServer({ sysProbe: probe({
      storage: { totalBytes: 100e9, availBytes: 12e9, usedPct: 88 },
      logsBytes: 1.4 * 1024 * 1024 * 1024,
      rssBytes: 450 * 1024 * 1024,
      sysFreePct: 7,
    }), config: {} });
    const bad = renderHeartbeat(greenSections({ server: sick }), NOW);
    ok(bad.startsWith('\u{26A0}\u{FE0F} *Bid Command: attention needed*'), 'a full disk (and friends) flips the verdict');
    ok(bad.includes('the server storage is 88% full'), 'storage over the threshold is spelled out under the verdict');
    ok(bad.includes("Bid Command's log files have grown to 1.4 GB"), 'oversized logs are an issue');
    ok(bad.includes('using 450 MB of its 500 MB memory limit'), 'process memory near the PM2 cap is an issue');
    ok(bad.includes('low on free memory (7% left)'), 'a squeezed shared box is an issue');
    ok(bad.includes('*Server* - storage 88% used'), 'the standing line still states the numbers alongside the issues');

    // partial read: only the facts that came back appear on the standing line; nulls never invent an issue
    const partly = await collectServer({ sysProbe: probe({ storage: null, logsBytes: null, sysFreePct: null }), config: {} });
    const partMsg = renderHeartbeat(greenSections({ server: partly }), NOW);
    ok(partMsg.startsWith('\u{2705}'), 'null (unreadable) facts never invent an issue');
    ok(partMsg.includes('*Server* - memory 180 MB, uptime 6 days') && !partMsg.includes('storage'), 'only the facts that were read appear on the standing line');

    // a thrown probe degrades to could-not-read (fail quiet-loud) and flips the verdict
    const threw = renderHeartbeat(greenSections({ server: { ok: false } }), NOW);
    ok(threw.includes('could not read its server health'), 'a thrown probe is named in plain words and flips the verdict');

    // no server section at all (an older heartbeat build / probe never injected): renders nothing, unchanged message
    const none = renderHeartbeat(greenSections(), NOW);
    ok(!none.includes('*Server*') && emojiCount(none) === 3, 'no server section -> no Server line, existing message unchanged');
  }

  // ---- resolveRecipients ----
  {
    const people = [
      { personId: 'p919000000001', name: 'Central Pricing Desk', phone: '+919000000001', enabled: true },
      { personId: 'g123456789012', name: 'Suyashh Gupta - BRL group', phone: '123456789012@g.us', enabled: true },
      { personId: 'p919594937777', name: 'Suyashh Gupta', phone: '+919594937777', enabled: true },
    ];
    const cfg = (recipients, name) => ({ heartbeat: { recipients, defaultRecipientName: name || 'Suyashh' } });
    const r1 = await resolveRecipients({ config: cfg([]), personStore: fakePersonStore(people) });
    ok(r1.length === 1 && r1[0].phone === '+919594937777', 'default resolves the Suyashh PERSON, skipping the same-named group');
    const r2 = await resolveRecipients({ config: cfg(['p919000000001', '+91 90000 00099']), personStore: fakePersonStore(people) });
    ok(r2.length === 2 && r2[0].phone === '+919000000001' && r2[1].phone === '+91 90000 00099', 'explicit list mixes person ids and raw phones');
    const r3 = await resolveRecipients({ config: cfg(['p-nonexistent', 'p919594937777']), personStore: fakePersonStore(people) });
    ok(r3.length === 1 && r3[0].phone === '+919594937777', 'an unknown id is skipped without costing the rest');
    const r4 = await resolveRecipients({ config: cfg([], 'nobody-by-this-name'), personStore: fakePersonStore(people) });
    ok(r4.length === 0, 'no match resolves to empty (logged loudly by the caller path)');
  }

  // ---- resolveRecipients: multi-name default (the operating trio) ----
  {
    const trio = [
      { personId: 'p919594937777', name: 'Suyashh Gupta', phone: '+919594937777', enabled: true },
      { personId: 'g120363410658010519', name: 'BRL Bids - Borosil', phone: '120363410658010519@g.us', enabled: true },
      { personId: 'p919594963468', name: 'Sushant Govinde', phone: '+919594963468', enabled: true },
      { personId: 'p919356252711', name: 'Siddharth Rodrigues', phone: '+919356252711', enabled: true },
      { personId: 'p919000000009', name: 'Pavan Konda', phone: '+919000000009', enabled: true },
    ];
    const dflt = (name) => ({ heartbeat: { recipients: [], defaultRecipientName: name } });

    const all3 = await resolveRecipients({ config: dflt('Suyashh,Sushant,Siddharth'), personStore: fakePersonStore(trio) });
    ok(all3.length === 3, 'the comma-name default resolves ALL three of the operating trio, not just the director');
    ok(all3.map((r) => r.phone).join(',') === '+919594937777,+919594963468,+919356252711',
      'the trio resolves in people-list order, and a same-named BRL group JID is skipped (individual DMs only)');

    const withMiss = await resolveRecipients({ config: dflt('Suyashh,Nobody-Here,Sushant'), personStore: fakePersonStore(trio) });
    ok(withMiss.length === 2 && withMiss[0].phone === '+919594937777' && withMiss[1].phone === '+919594963468',
      'a fragment that matches nobody contributes nobody - one absent name never costs the rest their message');

    const dupPhone = [
      { personId: 'p1', name: 'Suyashh Gupta', phone: '+919594937777', enabled: true },
      { personId: 'p2', name: 'Suyashh Gupta (duplicate record)', phone: '+919594937777', enabled: true },
    ];
    const deduped = await resolveRecipients({ config: dflt('Suyashh'), personStore: fakePersonStore(dupPhone) });
    ok(deduped.length === 1, 'two people records on the same phone dedupe to one message');

    const withDisabled = [
      { personId: 'p919594963468', name: 'Sushant Govinde', phone: '+919594963468', enabled: false },
      { personId: 'p919356252711', name: 'Siddharth Rodrigues', phone: '+919356252711', enabled: true },
    ];
    const skipDisabled = await resolveRecipients({ config: dflt('Sushant,Siddharth'), personStore: fakePersonStore(withDisabled) });
    ok(skipDisabled.length === 1 && skipDisabled[0].phone === '+919356252711', 'a disabled person is skipped on the default path');
  }

  // ---- runHeartbeat: send + state, degraded gather, failed send ----
  {
    const store = new MemoryStore();
    const n = fakeNotifier();
    const deps = {
      stacks: [fakeStack('primary', 'Primary', [1, 2], NOW + 100 * DAY)],
      store, requests: fakeRequests([]), personStore: fakePersonStore([{ personId: 'p1', name: 'Suyashh Gupta', phone: '+919594937777', enabled: true }]),
      wa: { enabled: () => true, sessionHealthy: async () => true },
      notifier: n, config: { notifyMode: 'whatsapp', heartbeat: { recipients: [], defaultRecipientName: 'Suyashh' } },
      now: NOW,
    };
    const res = await runHeartbeat(deps);
    ok(res.sent === 1 && n.sends.length === 1, 'heartbeat sent to the resolved recipient');
    ok(n.sends[0].opts.kind === 'heartbeat', 'send is tagged kind=heartbeat for log correlation');
    ok(asciiButEmoji(n.sends[0].message), 'sent message is ASCII outside the deliberate emoji set');
    const state = await store.getDoc(COLLECTION, STATE_KEY);
    ok(state && state.sentDate === '2026-07-16', 'a successful send records sentDate (the catch-up dedupe)');
    ok(state.branchCounts && state.branchCounts.primary === 2, 'branch counts persisted for tomorrow\'s comparison');
  }
  {
    // The one failure mode this feature exists to prevent: the gather itself dying
    // must still produce a message saying so.
    const store = new MemoryStore();
    const n = fakeNotifier();
    const deps = {
      stacks: [], store, requests: fakeRequests([]),
      personStore: fakePersonStore([{ personId: 'p1', name: 'Suyashh Gupta', phone: '+919594937777', enabled: true }]),
      wa: { enabled: () => true }, notifier: n,
      config: { notifyMode: 'whatsapp', heartbeat: { recipients: [], defaultRecipientName: 'Suyashh' } },
      now: NOW,
    };
    const res = await runHeartbeat(deps, { collect: async () => { throw new Error('store exploded'); } });
    ok(res.sent === 1, 'a total gather failure STILL sends');
    ok(n.sends[0].message.includes('could not read Bid Command\'s records'), 'the degraded message says what it could not do');
    ok(n.sends[0].message.startsWith('\u{26A0}\u{FE0F} *Bid Command: attention needed*'), 'degraded message keeps the verdict-first contract, warning-signed');
    ok(emojiCount(n.sends[0].message) === 1, 'degraded message is stark: the warning sign and nothing else');
  }
  {
    // A failed send must not mark the day as done - the boot catch-up retries off sentDate.
    const store = new MemoryStore();
    const failing = { sendDirect: async () => ({ ok: false, error: 'http 500' }) };
    const deps = {
      stacks: [], store, requests: fakeRequests([]),
      personStore: fakePersonStore([{ personId: 'p1', name: 'Suyashh Gupta', phone: '+919594937777', enabled: true }]),
      wa: { enabled: () => true }, notifier: failing,
      config: { notifyMode: 'whatsapp', heartbeat: { recipients: [], defaultRecipientName: 'Suyashh' } },
      now: NOW,
    };
    const res = await runHeartbeat(deps);
    ok(res.sent === 0, 'failed send reports 0 sent');
    const state = await store.getDoc(COLLECTION, STATE_KEY);
    ok(state && state.sentDate == null && state.lastRunAt === NOW, 'sentDate is NOT written on a failed send (catch-up stays armed), lastRunAt is');
  }

  // ---- startDailyHeartbeat: gate, handle, boot catch-up + its sentDate dedupe ----
  {
    ok(startDailyHeartbeat({ config: { heartbeat: { enabled: false } } }) === null, 'disabled config starts nothing');

    // Freeze the clock 10 minutes past the slot: inside the catch-up window, with no
    // sentDate on file -> the missed 08:00 fire is made up at boot.
    const realNow = Date.now;
    Date.now = () => NOW + 10 * 60000;
    try {
      const store = new MemoryStore();
      const n = fakeNotifier();
      const deps = {
        stacks: [], store, requests: fakeRequests([]),
        personStore: fakePersonStore([{ personId: 'p1', name: 'Suyashh Gupta', phone: '+919594937777', enabled: true }]),
        wa: { enabled: () => true }, notifier: n,
        config: { notifyMode: 'whatsapp', heartbeat: { enabled: true, timeIST: '08:00', recipients: [], defaultRecipientName: 'Suyashh' } },
      };
      const handle = startDailyHeartbeat(deps);
      ok(handle && typeof handle.stop === 'function', 'enabled start returns a stoppable handle');
      await new Promise((r) => setTimeout(r, 50)); // let the fire-and-forget catch-up settle
      ok(n.sends.length === 1, `boot inside the catch-up window with no sentDate sends the missed heartbeat (got ${n.sends.length})`);
      handle.stop();

      // Same boot again, but today's sentDate is now on file -> a restart after a
      // successful send must NOT double-send.
      const n2 = fakeNotifier();
      const handle2 = startDailyHeartbeat(Object.assign({}, deps, { notifier: n2 }));
      await new Promise((r) => setTimeout(r, 50));
      ok(n2.sends.length === 0, 'catch-up dedupes on sentDate - a post-send restart is silent');
      handle2.stop();
    } finally {
      Date.now = realNow;
    }
  }

  // ---- Notifier.sendDirect: transport + notifications stream, disabled gate ----
  {
    const calls = [];
    const transport = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm1' } }) }; };
    const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '1', transport });
    const store = new MemoryStore();
    const notifier = new Notifier({ mode: 'whatsapp', wa, store });
    const res = await notifier.sendDirect('+91 95949 37777', 'hello', { kind: 'heartbeat', name: 'Suyashh Gupta' });
    ok(res.ok === true, 'sendDirect delivers through the WhatsApp client');
    ok(calls[0].body.to_number === '919594937777', 'recipient number cleaned like any other send');
    const recorded = await store.readEvents('notifications');
    ok(recorded.length === 1 && recorded[0].kind === 'heartbeat' && recorded[0].ok === true, 'attempt recorded on the notifications stream');

    const dark = new Notifier({ mode: 'whatsapp', wa: new WhatsAppClient({ enabled: false }), store });
    const res2 = await dark.sendDirect('+919594937777', 'hello', { kind: 'heartbeat' });
    ok(res2.ok === false && res2.skipped === true, 'disabled WhatsApp skips cleanly (logged upstream), never throws');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
