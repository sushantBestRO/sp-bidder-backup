'use strict';
/**
 * Interactive snipe demo. Logs into BRL's real SuperProcure account, lists the
 * live auctions, lets you pick one + enter your cost, then runs the bidding
 * strategy (margin band 12/8/6) with a live rank+countdown counter.
 *
 *   node scripts/snipe.js                         # interactive (the demo)
 *   node scripts/snipe.js --list                  # just print loads and exit
 *   node scripts/snipe.js --cost 50000            # non-interactive, auto-pick a load, DRY-RUN
 *   node scripts/snipe.js --load <id> --cost 999999 --live   # LIVE, high cost so it can't win
 *
 * DRY-RUN unless --live. LIVE places real bids (interactive asks to confirm).
 */
const fs = require('fs');
const readline = require('readline');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { SpSocket } = require('../src/platform/spSocket');
const { SnipeHarness } = require('../src/engine/snipeHarness');

const COOKIE_FILE = process.env.COOKIE_FILE || 'C:\\Users\\sidro\\Downloads\\app.superprocure.com_cookies.txt';
const token = () => { for (const l of fs.readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/)) { if (l.startsWith('#') || !l.trim()) continue; const p = l.split('\t'); if (p[5] === 'token') return p[6]; } };
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const flag = (n) => process.argv.includes(n);
const money = (n) => (n == null ? '-' : 'Rs ' + Number(n).toLocaleString('en-IN'));
const mmss = (ms) => { if (ms == null) return '  --'; const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'; };

// refreshing one-line counter + clean step logs above it (no ANSI; Windows-safe)
const W = 96;
let statusText = '';
function setStatus(t) { statusText = t; process.stdout.write('\r' + t.padEnd(W).slice(0, W)); }
function logLine(t) { process.stdout.write('\r' + ' '.repeat(W) + '\r' + t + '\n'); if (statusText) process.stdout.write(statusText.padEnd(W).slice(0, W)); }

(async () => {
  const tok = token();
  process.stdout.write('logging in to your SuperProcure account... ');
  const a = new RealSuperProcureAdapter({ token: tok });
  const acct = await a.login();
  console.log(`OK\n  ${acct.user} | Best Roadways | carrier ${acct.carrierId}`);

  process.stdout.write('connecting to the live auction feed... ');
  const sock = new SpSocket({ token: tok, carrierId: acct.carrierId, userId: acct.userId, onLog: () => {} });
  await sock.connect();
  console.log('OK');

  const loads = await a.listAuctions();
  const live = loads.filter((l) => l.status === 'live');
  const sched = loads.filter((l) => l.status === 'scheduled').sort((x, y) => (x.startsAt || 0) - (y.startsAt || 0));
  const list = [...live, ...sched.slice(0, 10)];

  console.log(`\n  your auction loads (${live.length} live, ${sched.length} scheduled):\n`);
  console.log('   #  STATUS    LANE                              VEHICLE           SHIPPER      WHEN              BIDS  CLOSE   id');
  console.log('  ' + '-'.repeat(116));
  list.forEach((l, i) => {
    const when = l.status === 'live' ? 'closes ' + mmss(l.closesAt - a.serverNow()) : 'starts ' + mmss((l.startsAt || l.closesAt) - a.serverNow());
    console.log('  ' + [
      String(i + 1).padStart(2), (l.status === 'live' ? '* LIVE' : ' sched').padEnd(8),
      (l.lane.origin + ' -> ' + l.lane.destination).slice(0, 32).padEnd(33),
      (l.equipment || '').slice(0, 16).padEnd(17), (l.companyName || '').slice(0, 11).padEnd(12),
      when.padEnd(16), String(l.revisionLimit || '?').padEnd(5), (l.softClose ? 'soft' : 'hard').padEnd(6), l.id,
    ].join(' '));
  });

  if (flag('--list')) { sock.close(); return process.exit(0); }
  if (!list.length) { console.log('\nno auctions to bid on right now.'); sock.close(); return process.exit(0); }

  let load, cost, maxM, minM, isLive;
  const argCost = Number(String(arg('--cost') || '').replace(/[^\d.]/g, ''));

  if (argCost > 0) {
    // ---- non-interactive (scriptable / testable) ----
    const idArg = arg('--load');
    load = idArg ? list.find((l) => String(l.id) === String(idArg)) || loads.find((l) => String(l.id) === String(idArg)) : list[0];
    if (!load) { console.log('load not found:', idArg); sock.close(); return process.exit(1); }
    cost = argCost;
    [maxM, minM] = String(arg('--margins') || '12,6').split(',').map(Number);
    isLive = flag('--live');
    console.log(`\n(non-interactive) ${load.lane.origin} -> ${load.lane.destination} | cost ${money(cost)} | ${isLive ? 'LIVE' : 'DRY-RUN'}`);
  } else {
    // ---- interactive (the demo) ----
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((res) => rl.question(q, res));
    const sel = await ask('\nselect load # (q to quit): ');
    if (/^\s*q/i.test(sel)) { rl.close(); sock.close(); return process.exit(0); }
    load = list[Number(sel) - 1];
    if (!load) { console.log('invalid selection'); rl.close(); sock.close(); return process.exit(1); }
    const costStr = await ask(`enter your COST for ${load.lane.origin} -> ${load.lane.destination} (Rs): `);
    cost = Number(costStr.replace(/[^\d.]/g, ''));
    if (!(cost > 0)) { console.log('need a cost > 0'); rl.close(); sock.close(); return process.exit(1); }
    const mStr = await ask('margins max,min  [enter = 12,6]: ');
    [maxM, minM] = (mStr.trim() || '12,6').split(',').map(Number);
    const modeStr = await ask('mode - [d]ry-run (no real bids)  or  [l]ive (real bids)?  [d]: ');
    if (/^l/i.test(modeStr.trim())) {
      const c = await ask('  LIVE places REAL bids on the account. type "yes" to confirm: ');
      isLive = /^yes\s*$/i.test(c.trim());
      if (!isLive) console.log('  not confirmed - running DRY-RUN.');
    }
    rl.close();
  }
  if (!(maxM > 0)) maxM = 12;
  if (!(minM > 0)) minM = 6;

  console.log(`\n  floor (at ${minM}%) = ${money(Math.round(cost * (1 + minM / 100)))}   |   open (at ${maxM}%) = ${money(Math.round(cost * (1 + maxM / 100)))}`);
  console.log(`  ${load.softClose ? 'SOFT close (anti-snipe) -> hold rank 1 on the thinnest margin' : 'HARD close -> snipe the floor in the final seconds'}   |   ${load.revisionLimit || '?'} bids allowed\n`);

  const harness = new SnipeHarness({ realAdapter: a, sock, log: logLine });
  harness.arm(load, { cost, maxMarginPct: maxM, minMarginPct: minM, live: isLive });

  process.on('SIGINT', () => { harness.stop(); process.stdout.write('\n(stopped)\n'); sock.close(); process.exit(0); });

  const deadline = Date.now() + Number(arg('--seconds') || 3600) * 1000;
  const ticker = setInterval(() => {
    const st = sock.state(load.id) || {};
    const ms = sock.closesInMs(load.id, load.closesAt);
    const win = st.myRank === 1 ? '  <= WINNING (L1)' : '';
    setStatus(`  rank ${st.myRank ?? '-'} | ${mmss(ms)} left | your bid ${money(st.myAmount)} | bids ${harness.bidsUsed}/${harness.bidLimit}${st.extended ? ' | EXTENDED' : ''}${win}`);
    if (harness.done || Date.now() > deadline) { clearInterval(ticker); harness.stop(); process.stdout.write('\n'); sock.close(); setTimeout(() => process.exit(0), 300); }
  }, 1000);
})().catch((e) => { console.error('\nsnipe failed:', e.message); process.exit(1); });
