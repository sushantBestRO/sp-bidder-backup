'use strict';
// Server smoke test: assumes the server is already running on PORT (default 4311).
// Seeds the demo slate, polls /api/state until auctions resolve, prints a summary.
const PORT = process.env.PORT || 4311;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function j(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function main() {
  // wait for server up
  let up = false;
  for (let i = 0; i < 20; i++) {
    try { await j('GET', '/api/state'); up = true; break; } catch (_) { await sleep(300); }
  }
  if (!up) { console.error('server not reachable'); process.exit(1); }

  const seeded = await j('POST', '/api/demo/seed');
  console.log('seeded:', seeded.seeded.map(s => `${s.competitors}r/${s.closeModel}`).join(', '));

  let last = null;
  const deadline = Date.now() + 130_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    last = await j('GET', '/api/state');
    const open = last.auctions.filter(a => a.status === 'open').length;
    const bids = last.events.filter(e => e.type === 'bid_placed').length;
    const results = last.auctions.filter(a => a.status === 'closed');
    process.stdout.write(`\r open=${open} closed=${results.length} bidEvents(recent)=${bids} logins=${last.auth.loginCount}   `);
    if (open === 0 && results.length > 0) break;
  }
  console.log('\n');

  console.log('capabilities:', JSON.stringify(last.capabilities));
  let breaches = 0, wins = 0;
  for (const a of last.auctions) {
    const won = a.won === true || a.finalUsRank === 1;
    if (won) wins++;
    const lowest = a.bot && a.bot.lastBidPrice;
    if (a.bot && a.bot.floor && lowest != null && lowest < a.bot.floor) breaches++;
    console.log(
      `${a.id} ${a.closeModel.padEnd(4)} ${String(a.totalBidders).padStart(2)}bidders ` +
      `${a.lane.origin} -> ${a.lane.destination}`.padEnd(46) +
      ` status=${a.status} finalRank=${a.finalUsRank ?? a.ourRank} ` +
      `won=${won} lastBid=${lowest ?? '-'} floor=${a.bot ? a.bot.floor : '-'} stoodDown=${a.bot ? a.bot.stoodDown : '-'}`);
  }
  const alerts = last.events.filter(e => e.type === 'alert');
  console.log(`\nwins=${wins}/${last.auctions.length} floorBreaches=${breaches} logins=${last.auth.loginCount} alertsRecent=${alerts.length}`);
  console.log(breaches === 0 ? 'SERVER SMOKE: PASS' : 'SERVER SMOKE: FAIL (floor breach)');
  process.exit(breaches === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
