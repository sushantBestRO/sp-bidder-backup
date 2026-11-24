'use strict';
/**
 * READ-ONLY deep capture: definitively answer "do EXTERNAL (non-Best-Roadways)
 * competitor amounts appear on the socket?" Watches the live/contested window and
 * tracks the full set of distinct non-self carriers, flags which are EXTERNAL
 * (company != Best Roadways), and records per-load whether we ever held rank>=2 (an
 * external L1 exists) yet saw no external row (= masking evidence). Never bids.
 *
 *   node scripts/recon-external.js [--seconds 540]
 *
 * PII: writes any external-row frame to RECON_OUT_DIR only (set it to a scratchpad),
 * never the repo. Run this when recon-sweep flags a live/contested window,
 * ideally on a SHOWL1RATE_TRUE load (the clean confirm the masking finding wants).
 */
const fs = require('fs');
const path = require('path');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { SpSocket } = require('../src/platform/spSocket');

const COOKIE_FILE = process.env.COOKIE_FILE || 'C:\\Users\\sidro\\Downloads\\app.superprocure.com_cookies.txt';
const token = () => { for (const l of fs.readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/)) { if (l.startsWith('#') || !l.trim()) continue; const p = l.split('\t'); if (p[5] === 'token') return p[6]; } };
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const isBRL = (name) => String(name || '').toLowerCase().includes('best roadways');

(async () => {
  const a = new RealSuperProcureAdapter({ token: token() });
  const acct = await a.login();
  const selfId = Number(acct.carrierId);
  console.log(`logged in: ${acct.user} | carrier(self)=${selfId}`);
  const sock = new SpSocket({ token: token(), carrierId: selfId, userId: acct.userId, onLog: () => {} });

  const carriers = new Map();     // carrierId -> { companyName, maxAmount, external, frames }
  const loadInfo = new Map();     // loadId -> { ourRank, externalRowsSeen, companies:Set }
  let framesSeen = 0, externalAmountSeen = false, externalRow = null;

  sock.onUpdate = (loadId, _cur, p) => {
    framesSeen++;
    const bids = Array.isArray(p.bids) ? p.bids : [];
    const li = loadInfo.get(loadId) || { ourRank: null, externalRowsSeen: 0, companies: new Set() };
    for (const b of bids) {
      const cid = Number(b.carrierId), name = b.companyName || b.company;
      const amt = typeof b.amount === 'number' ? b.amount : (b.amount != null && !isNaN(+b.amount) ? +b.amount : null);
      if (cid === selfId) { if (b.rank != null) li.ourRank = b.rank; continue; }
      li.companies.add(`${cid}:${name}`);
      const ext = !isBRL(name);
      const rec = carriers.get(cid) || { companyName: name, maxAmount: null, external: ext, frames: 0 };
      rec.frames++; if (amt != null && (rec.maxAmount == null || amt > rec.maxAmount)) rec.maxAmount = amt;
      carriers.set(cid, rec);
      if (ext) { li.externalRowsSeen++; if (amt != null && amt > 0) { externalAmountSeen = true; if (!externalRow) externalRow = { loadId, carrierId: cid, companyName: name, amount: amt, rank: b.rank, frame: p }; } }
    }
    loadInfo.set(loadId, li);
  };

  await sock.connect();
  const loads = await a.listAuctions();
  const live = loads.filter((l) => l.status === 'live');
  console.log(`${loads.length} loads, ${live.length} live. Watching all live + scheduled...\n`);
  for (const l of live) sock.watch(l.id, l.isOpenAuction ? 1 : 0);
  loads.filter((l) => l.status === 'scheduled').forEach((l) => sock.watch(l.id, l.isOpenAuction ? 1 : 0));

  await new Promise((r) => setTimeout(r, Number(arg('--seconds', 540)) * 1000));
  sock.close();

  console.log('==================== EXTERNAL-VISIBILITY RECON ====================');
  console.log(`frames seen: ${framesSeen} | distinct non-self carriers: ${carriers.size}`);
  for (const [cid, r] of carriers) console.log(`  ${r.external ? 'EXTERNAL' : 'BRL-own '} carrier=${cid} company=${JSON.stringify(r.companyName)} maxAmount=${r.maxAmount} (${r.frames} rows)`);
  if (!carriers.size) console.log('  (no non-self rows seen)');
  const masked = [...loadInfo.entries()].filter(([, li]) => li.ourRank != null && li.ourRank >= 2 && li.externalRowsSeen === 0);
  console.log(`\nVERDICT: external (non-BRL) competitor amount seen live? ${externalAmountSeen ? 'YES' : 'NO'}`);
  if (externalRow) console.log(`  external row: load ${externalRow.loadId} carrier=${externalRow.carrierId} ${JSON.stringify(externalRow.companyName)} amount=${externalRow.amount} rank=${externalRow.rank}`);
  console.log(`masking evidence (we were rank>=2 so an external L1 exists, but no external row in feed):`);
  if (masked.length) for (const [lid, li] of masked) console.log(`  load ${lid}: ourRank=${li.ourRank}, external rows=0 -> external L1 amount NOT shown`);
  else console.log('  (none observed this window)');
  if (externalRow) { const out = path.join(process.env.RECON_OUT_DIR || '.', `recon-external-frame-${externalRow.loadId}.json`); fs.writeFileSync(out, JSON.stringify(externalRow.frame, null, 2)); console.log(`\nraw external frame (PII) -> ${out}`); }
  console.log('==================================================================');
  process.exit(0);
})().catch((e) => { console.error('recon-external failed:', e.message); process.exit(1); });
