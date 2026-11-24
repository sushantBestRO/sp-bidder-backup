'use strict';
/**
 * READ-ONLY customer census — the 30-minute recon monitor's per-cycle probe.
 * Logs into every configured SP account (read side only: login + listAuctions),
 * collects the distinct set of customer companyNames currently visible across all
 * of them, merges into a rolling UNION keyed by companyName, and emits ONE summary
 * line the Monitor tool turns into a notification. NEVER bids, no socket, no writes
 * to SP — same read-only posture as recon-sweep.js.
 *
 * Why a union that accumulates: live SP auctions rotate through the day. A single
 * snapshot only sees who is posting right now; a customer live at 15:00 may be idle
 * at 13:00. Re-running every 30 min and unioning the results builds COMPLETE coverage
 * of intermittently-active customers over time — which is the whole point of the
 * "by the time I get to it, all recon is done" ask. The first time a brand-new
 * company appears (e.g. Safex), it lands in the NEW list of that cycle's summary.
 *
 *   node scripts/recon-census.js
 *
 * Accounts are the cookie files in COOKIES (below); a missing/expired one is skipped
 * loudly, never fatal — one dead token must not blind the whole census.
 *
 * Output line shape (stdout, exactly one line, Monitor-friendly):
 *   CENSUS <ist> | acct ok=A/err=E | companies=N (+K new: names) | live=L loads=T | <detail>
 * Files written (all under _research/data/recon-census/, gitignored research area):
 *   census-union.json           — the accumulating union (first_seen/last_seen/accounts/...)
 *   snapshots/<utcstamp>.json    — the full raw per-cycle snapshot, for later digging
 */
const fs = require('fs');
const path = require('path');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

const DL = 'C:\\Users\\sidro\\Downloads';
// label -> cookie file. Order = the accounts we currently hold tokens for.
const COOKIES = [
  ['primary', path.join(DL, 'app.superprocure.com_cookies.txt')],           // carrier 10686
  ['sameer', path.join(DL, 'app.superprocure.com_cookies (1).txt')],        // carrier 4441
  ['master', path.join(DL, 'app.superprocure.com_cookies (2).txt')],        // carrier 2667 (workhorse)
];
const OUT_DIR = path.resolve(__dirname, '..', '..', '_research', 'data', 'recon-census');
const UNION_FILE = path.join(OUT_DIR, 'census-union.json');
const SNAP_DIR = path.join(OUT_DIR, 'snapshots');

const ist = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
const readToken = (file) => {
  for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (l.startsWith('#') || !l.trim()) continue;
    const p = l.split('\t');
    if (p[5] === 'token') return p[6];
  }
  return null;
};

(async () => {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const nowIso = new Date().toISOString();
  const snapshot = { at: nowIso, accounts: {}, companies: {} };
  let okAccts = 0, errAccts = 0, totalLoads = 0, liveLoads = 0;

  for (const [label, file] of COOKIES) {
    if (!fs.existsSync(file)) { snapshot.accounts[label] = { error: 'no cookie file' }; errAccts++; continue; }
    let token;
    try { token = readToken(file); } catch (e) { snapshot.accounts[label] = { error: 'read failed: ' + e.message }; errAccts++; continue; }
    if (!token) { snapshot.accounts[label] = { error: 'no token line' }; errAccts++; continue; }
    try {
      const a = new RealSuperProcureAdapter({ token });
      const acct = await a.login();
      const loads = await a.listAuctions();
      okAccts++;
      snapshot.accounts[label] = { user: acct.user, carrierId: acct.carrierId, branches: acct.branchIds.length, loadCount: loads.length, tokenExp: acct.tokenExp };
      for (const l of loads) {
        totalLoads++;
        if (l.status === 'live') liveLoads++;
        const name = String(l.companyName || '(unknown)').trim();
        const c = snapshot.companies[name] || { total: 0, live: 0, accounts: new Set(), closeModels: new Set(), statuses: new Set() };
        c.total++;
        if (l.status === 'live') c.live++;
        c.accounts.add(`${label}:${acct.carrierId}`);
        c.closeModels.add(l.softClose ? 'soft' : 'hard');
        c.statuses.add(l.status);
        snapshot.companies[name] = c;
      }
    } catch (e) {
      snapshot.accounts[label] = { error: e.message };
      errAccts++;
    }
  }

  // serialize Sets in the snapshot
  const compList = {};
  for (const [name, c] of Object.entries(snapshot.companies)) {
    compList[name] = { total: c.total, live: c.live, accounts: [...c.accounts].sort(), closeModels: [...c.closeModels].sort(), statuses: [...c.statuses].sort() };
  }
  snapshot.companies = compList;

  // merge into rolling union
  let union = { first_run: nowIso, last_run: nowIso, runs: 0, companies: {} };
  if (fs.existsSync(UNION_FILE)) { try { union = JSON.parse(fs.readFileSync(UNION_FILE, 'utf8')); } catch (_) {} }
  union.last_run = nowIso; union.runs = (union.runs || 0) + 1;
  const newNames = [];
  for (const [name, c] of Object.entries(compList)) {
    const u = union.companies[name];
    if (!u) {
      newNames.push(name);
      union.companies[name] = { first_seen: nowIso, last_seen: nowIso, times_seen: 1, accounts: c.accounts, closeModels: c.closeModels, max_loads: c.total, ever_live: c.live > 0 };
    } else {
      u.last_seen = nowIso; u.times_seen = (u.times_seen || 0) + 1;
      u.accounts = [...new Set([...(u.accounts || []), ...c.accounts])].sort();
      u.closeModels = [...new Set([...(u.closeModels || []), ...c.closeModels])].sort();
      u.max_loads = Math.max(u.max_loads || 0, c.total);
      u.ever_live = u.ever_live || c.live > 0;
    }
  }

  fs.writeFileSync(UNION_FILE, JSON.stringify(union, null, 2));
  const snapName = nowIso.replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(SNAP_DIR, snapName + '.json'), JSON.stringify(snapshot, null, 2));

  const nCompanies = Object.keys(compList).length;
  const nUnion = Object.keys(union.companies).length;
  const newStr = newNames.length ? `+${newNames.length} NEW: ${newNames.join('; ')}` : 'no new';
  const errStr = errAccts ? ' | ' + Object.entries(snapshot.accounts).filter(([, v]) => v.error).map(([k, v]) => `${k}:${v.error}`).join(', ') : '';
  console.log(`CENSUS ${ist(nowIso)} IST | acct ok=${okAccts}/err=${errAccts} | now=${nCompanies} union=${nUnion} (${newStr}) | live=${liveLoads} loads=${totalLoads}${errStr}`);
  process.exit(okAccts > 0 ? 0 : 2);
})().catch((e) => { console.log(`CENSUS ERROR ${e.message}`); process.exit(3); });
