'use strict';
/**
 * READ-ONLY recon: does the SuperProcure socket expose COMPETITORS' bid AMOUNTS
 * (and identity) live, or only our own rank?
 *
 * Logs into the real account, connects the live socket, watches every live load,
 * and inspects the raw `bidListenerV2` bids[] array frame-by-frame. Records, per
 * load, the richest frame (most distinct carriers) and reports whether any
 * non-self row carries a numeric amount / a name. NEVER emits a bid (SpSocket is
 * read-side only: join_v2 / auctionStart / bidListenerV2_ACK).
 *
 *   node scripts/recon-socket-frames.js [--seconds 90]
 */
const fs = require('fs');
const path = require('path');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { SpSocket } = require('../src/platform/spSocket');

const COOKIE_FILE = process.env.COOKIE_FILE || 'C:\\Users\\sidro\\Downloads\\app.superprocure.com_cookies.txt';
const token = () => { for (const l of fs.readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/)) { if (l.startsWith('#') || !l.trim()) continue; const p = l.split('\t'); if (p[5] === 'token') return p[6]; } };
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const num = (v) => (typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && !isNaN(+v) ? +v : null));

(async () => {
  const tok = token();
  const a = new RealSuperProcureAdapter({ token: tok });
  const acct = await a.login();
  const selfId = Number(acct.carrierId);
  console.log(`logged in: ${acct.user} | carrier(self)=${selfId} | branches=${acct.branchIds.length}`);

  const sock = new SpSocket({ token: tok, carrierId: selfId, userId: acct.userId, onLog: (m) => console.log('  [sock]', m) });

  // per-load richest frame (max distinct carriers) + running verdict flags
  const richest = new Map();           // loadId -> { nCarriers, frame, bids }
  let anyCompetitorAmount = false;     // a non-self row with a finite amount > 0
  let anyCompetitorName = false;       // a non-self row with a non-empty name-ish field
  let framesSeen = 0, multiBidderFrames = 0;
  const competitorKeysUnion = new Set();

  sock.onUpdate = (loadId, _cur, p) => {
    const bids = Array.isArray(p.bids) ? p.bids : [];
    framesSeen++;
    const carriers = new Set(bids.map((b) => Number(b.carrierId)));
    if (carriers.size > 1) multiBidderFrames++;
    const comp = bids.filter((b) => Number(b.carrierId) !== selfId);
    for (const b of comp) {
      Object.keys(b).forEach((k) => competitorKeysUnion.add(k));
      if (num(b.amount) != null && num(b.amount) > 0) anyCompetitorAmount = true;
      const name = b.companyName || b.company || b.carrierName || b.vendorName || b.name;
      if (name && String(name).trim()) anyCompetitorName = true;
    }
    const prev = richest.get(loadId);
    if (!prev || comp.length > (prev.nComp || 0) || carriers.size > prev.nCarriers) richest.set(loadId, { nCarriers: carriers.size, nComp: comp.length, frame: p, bids });
  };

  await sock.connect();
  const loads = await a.listAuctions();
  const live = loads.filter((l) => l.status === 'live');
  console.log(`\n${loads.length} loads, ${live.length} live. Watching live loads for competitor frames...\n`);
  for (const l of live) sock.watch(l.id, l.isOpenAuction ? 1 : 0);
  // also watch the soonest scheduled in case one goes live during the window
  loads.filter((l) => l.status === 'scheduled').slice(0, 8).forEach((l) => sock.watch(l.id, l.isOpenAuction ? 1 : 0));

  const seconds = Number(arg('--seconds', 90));
  await new Promise((r) => setTimeout(r, seconds * 1000));
  sock.close();

  // ---- report ----
  const ranked = [...richest.entries()].map(([id, v]) => ({ id, ...v })).sort((x, y) => (y.nComp - x.nComp) || (y.nCarriers - x.nCarriers));
  const top = ranked[0];
  console.log('==================== RECON RESULT ====================');
  console.log(`frames seen: ${framesSeen} | multi-bidder frames: ${multiBidderFrames} | loads with frames: ${ranked.length}`);
  console.log(`VERDICT: competitor AMOUNT visible live? ${anyCompetitorAmount ? 'YES' : 'NO'}`);
  console.log(`         competitor NAME/identity visible live? ${anyCompetitorName ? 'YES' : 'NO'}`);
  console.log(`competitor row keys seen: ${[...competitorKeysUnion].join(', ') || '(none)'}`);

  if (top && top.nComp > 0) {
    console.log(`\nrichest competitor-bearing frame: load ${top.id} | ${top.nCarriers} carrier(s), ${top.nComp} competitor row(s). Rows (PII redacted):`);
    for (const b of top.bids) {
      const self = Number(b.carrierId) === selfId;
      console.log(`  ${self ? 'SELF' : 'COMP'} carrier=${b.carrierId} company=${JSON.stringify(b.companyName || b.company)} rank=${b.rank} amount=${JSON.stringify(b.amount)} amountPMT=${JSON.stringify(b.amountPMT)} isActive=${b.isActive}`);
    }
    // raw frame -> gitignored scratchpad ONLY (carries userMobile/userName PII); never the repo
    const out = path.join(process.env.RECON_OUT_DIR || '.', `recon-richest-frame-${top.id}.json`);
    fs.writeFileSync(out, JSON.stringify(top.frame, null, 2));
    console.log(`\nraw frame (with PII) written to scratchpad only: ${out}`);
  } else {
    console.log('\nNo competitor rows captured. Re-run nearer a busy close (Tue 9-10am) or extend --seconds.');
  }
  console.log('======================================================');
  process.exit(0);
})().catch((e) => { console.error('recon failed:', e.message); process.exit(1); });
