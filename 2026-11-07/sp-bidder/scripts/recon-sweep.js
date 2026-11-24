'use strict';
/**
 * READ-ONLY recon sweep — the "should I care right now?" probe fired by the
 * weekday-morning recon cron. Logs in, lists auctions, and prints each load's
 * status/shipper/close-model/showL1Rate/countdown plus a machine-readable TRIGGERS
 * block the caller acts on (notify / deep-capture / nothing). NEVER bids — read-side
 * only (login + listAuctions). No socket, no capture; the deep capture is a separate
 * step (recon-socket-frames.js / recon-external.js) the caller runs when a trigger
 * says a contested window is live/imminent.
 *
 *   node scripts/recon-sweep.js
 *
 * Triggers (per the recon-testing charter):
 *   SYNGENTA_HARD_CLOSE   — an in-scope first-real-bid candidate is live/scheduled
 *   SHOWL1RATE_TRUE       — a load where the UI shows L1 (finishes the masking Q / live-read unlock)
 *   HARD_CLOSE_CANDIDATE  — any hard-close in-scope load usable for the can't-win write-path test
 *   CONTESTED_WINDOW_SOON — a live load closing within CONTEST_LEAD_MIN (bids land near close)
 */
const fs = require('fs');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

const COOKIE_FILE = process.env.COOKIE_FILE || 'C:\\Users\\sidro\\Downloads\\app.superprocure.com_cookies.txt';
const CONTEST_LEAD_MIN = Number(process.env.RECON_CONTEST_LEAD_MIN || 40);
const token = () => { for (const l of fs.readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/)) { if (l.startsWith('#') || !l.trim()) continue; const p = l.split('\t'); if (p[5] === 'token') return p[6]; } };
const rel = (ms) => { if (ms == null) return 'n/a'; const s = Math.round(ms / 1000), a = Math.abs(s), h = Math.floor(a / 3600), m = Math.floor((a % 3600) / 60); return (s < 0 ? '-' : '+') + `${h}h${m}m`; };
const ist = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

(async () => {
  const a = new RealSuperProcureAdapter({ token: token() });
  const acct = await a.login();
  const now = a.serverNow();
  console.log(`=== RECON SWEEP ${ist(now)} IST ===`);
  console.log(`account: ${acct.user} | carrier ${acct.carrierId} | ${acct.branchIds.length} branches | token exp ${new Date(acct.tokenExp).toISOString().slice(0,10)}`);

  const loads = await a.listAuctions();
  const by = { live: 0, scheduled: 0, closed: 0 };
  const isSyngenta = (n) => /syngenta/i.test(String(n || ''));
  const inWindow = (l) => l.closesAt && (l.status === 'live' || l.status === 'scheduled') && (l.closesAt - now) <= CONTEST_LEAD_MIN * 60000 && (l.closesAt - now) > 0;
  const trig = { SYNGENTA_HARD_CLOSE: [], SHOWL1RATE_TRUE: [], HARD_CLOSE_CANDIDATE: [], CONTESTED_WINDOW_SOON: [] };

  console.log(`\nloads: ${loads.length}`);
  for (const l of loads) {
    by[l.status] = (by[l.status] || 0) + 1;
    const cm = l.softClose ? 'soft' : 'hard';
    console.log(`  [${l.status}] ${l.id} | ${JSON.stringify(l.companyName)} | ${l.lane.origin}->${l.lane.destination} | ${cm}-close showL1=${l.showL1Rate} | closes ${rel(l.closesAt ? l.closesAt - now : null)} | rev${l.revisionLimit} ${l.equipment} x${l.units}`);
    if (l.status === 'closed') continue;
    if (isSyngenta(l.companyName) && !l.softClose) trig.SYNGENTA_HARD_CLOSE.push(l.id);
    if (l.showL1Rate) trig.SHOWL1RATE_TRUE.push(l.id);
    if (!l.softClose) trig.HARD_CLOSE_CANDIDATE.push(l.id);
    if (inWindow(l)) trig.CONTESTED_WINDOW_SOON.push(l.id);
  }
  console.log(`\nsummary: ${JSON.stringify(by)}`);

  console.log(`\n=== TRIGGERS ===`);
  let any = false;
  for (const [k, ids] of Object.entries(trig)) { const hit = ids.length > 0; if (hit) any = true; console.log(`${k}: ${hit ? 'YES ' + ids.join(',') : 'no'}`); }
  console.log(`ANY_TRIGGER: ${any ? 'YES' : 'no'}`);
  console.log(`=== END (read-only; no bids; no socket) ===`);
  process.exit(0);
})().catch((e) => { console.error('recon-sweep failed:', e.message); process.exit(1); });
