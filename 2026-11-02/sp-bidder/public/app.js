'use strict';
/* BidPilot - simple front-end. Polls /api/state, renders the story in plain words. */

const $ = (s) => document.querySelector(s);
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const money = (n) => (n == null ? '—' : inr.format(Math.round(n)));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  return res.json();
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => (t.hidden = true), 260); }, 3200);
}

function mmss(ms) {
  ms = Math.max(0, ms); const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/* ---- plain-language derivation ---- */
function derive(a) {
  const bot = a.bot;
  if (a.status === 'closed') return (a.won === true || a.finalUsRank === 1) ? 'won' : 'lost';
  if (!a.armed || !bot) return 'idle';
  if (bot.currentRungIndex < 0 || bot.lastBidPrice == null) return 'watching';
  if (a.ourRank === 1) return 'winning';
  if (bot.stoodDown) return 'held';
  return 'bidding';
}
const BADGE = {
  watching: { kind: 'idle', text: 'Watching' },
  bidding:  { kind: 'behind', text: (a) => 'Position #' + (a.ourRank || '-') },
  winning:  { kind: 'winning', text: 'Winning', dot: true },
  held:     { kind: 'held', text: 'At your floor' },
  won:      { kind: 'won', text: 'Won' },
  lost:     { kind: 'lost', text: "Didn't win" },
  idle:     { kind: 'idle', text: 'Idle' },
};
function statusLine(a, st) {
  const bot = a.bot || {};
  switch (st) {
    case 'watching': return 'Watching the auction. Will bid as it closes.';
    case 'bidding':  return 'Bidding to win &mdash; currently position #' + (a.ourRank || '-') + '.';
    case 'winning':  return "You're winning at <strong>" + money(bot.lastBidPrice) + '</strong>.';
    case 'held':     return "Holding at your floor &mdash; won't chase a load below cost.";
    case 'won':      return 'Won at <strong>' + money(bot.lastBidPrice) + '</strong> &mdash; ' +
                            money((bot.lastBidPrice || 0) - (bot.floor || 0)) + ' above your floor.';
    case 'lost':     return 'Didn&rsquo;t win &mdash; a rival went below your floor.';
    default:         return '';
  }
}

/* ---- rendering ---- */
const ICON_LOCK = '<svg class="ico" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const cards = new Map(); // id -> { el, refs, shownBid, closesAtLocal }

function buildCard(a) {
  const el = document.createElement('article');
  el.className = 'card';
  el.innerHTML =
    '<div class="card-head">' +
      '<div><div class="lane"><span class="o"></span><span class="arrow">&rarr;</span><span class="d"></span></div>' +
      '<div class="meta"></div></div>' +
      '<span class="badge"><span class="badge-dot" hidden></span><span class="badge-txt"></span></span>' +
    '</div>' +
    '<div class="figs">' +
      '<div class="fig fig-floor"><div class="fig-label">' + ICON_LOCK + ' Your floor</div>' +
        '<div class="fig-val v-floor"></div><div class="fig-sub">won&rsquo;t bid below this</div></div>' +
      '<div class="fig fig-bid"><div class="fig-label">Current bid</div>' +
        '<div class="fig-val v-bid"></div><div class="fig-sub s-bid"></div></div>' +
    '</div>' +
    '<div class="status"><span class="sdot"></span><span class="status-txt"></span></div>';
  const refs = {
    o: el.querySelector('.o'), d: el.querySelector('.d'), meta: el.querySelector('.meta'),
    badge: el.querySelector('.badge'), badgeDot: el.querySelector('.badge-dot'), badgeTxt: el.querySelector('.badge-txt'),
    figFloor: el.querySelector('.fig-floor'), figBid: el.querySelector('.fig-bid'),
    vFloor: el.querySelector('.v-floor'), vBid: el.querySelector('.v-bid'), sBid: el.querySelector('.s-bid'),
    status: el.querySelector('.status'), statusTxt: el.querySelector('.status-txt'),
  };
  return { el, refs, shownBid: null, closesAtLocal: 0 };
}

function animateBid(c, to) {
  const ref = c.refs.vBid; const from = c.shownBid;
  if (to == null) { ref.textContent = '—'; c.shownBid = null; return; }
  if (from == null || from === to || window.matchMedia('(prefers-reduced-motion:reduce)').matches) {
    ref.textContent = money(to); c.shownBid = to; return;
  }
  const t0 = performance.now(), dur = 420;
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur); const e = 1 - Math.pow(1 - p, 3);
    ref.textContent = money(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(tick); else { ref.textContent = money(to); c.shownBid = to; }
  };
  requestAnimationFrame(tick);
}

function updateCard(c, a) {
  const r = c.refs, bot = a.bot || {};
  const st = derive(a);
  r.o.textContent = a.lane.origin; r.d.textContent = a.lane.destination;

  // meta
  const soft = a.closeModel === 'soft' ? '<span class="soft-tag">auto-extends</span><span class="dot"></span>' : '';
  const time = a.status === 'closed' ? 'closed' : 'closes in <span class="cd">' + mmss(a.closesInMs) + '</span>';
  r.meta.innerHTML = a.equipment + '<span class="dot"></span>' + a.units + (a.units > 1 ? ' trucks' : ' truck') +
    '<span class="dot"></span>' + soft + time;
  c.closesAtLocal = a.status === 'closed' ? 0 : Date.now() + a.closesInMs;

  // badge
  const b = BADGE[st] || BADGE.idle;
  r.badge.dataset.kind = b.kind;
  r.badgeTxt.textContent = typeof b.text === 'function' ? b.text(a) : b.text;
  r.badgeDot.hidden = !b.dot;

  // figures
  r.vFloor.textContent = money(bot.floor);
  const winning = st === 'winning' || st === 'won';
  r.figBid.dataset.win = winning ? '1' : '0';
  animateBid(c, bot.lastBidPrice ?? null);
  const atFloor = bot.lastBidPrice != null && bot.floor != null && bot.lastBidPrice <= bot.floor;
  r.sBid.innerHTML = bot.lastBidPrice == null ? 'no bid yet'
    : (atFloor ? '<span class="atfloor">at your floor</span>' : 'live bid');

  // status + card win flag
  r.status.dataset.kind = st;
  r.statusTxt.innerHTML = statusLine(a, st);
  c.el.dataset.win = winning ? '1' : '0';
}

function render(state) {
  // connection
  const conn = $('#conn');
  if (conn.dataset.state === 'connected') { /* keep label set at connect time */ }

  // lede
  const list = state.auctions || [];
  const open = list.filter((a) => a.status === 'open');
  const winning = open.filter((a) => a.ourRank === 1).length;
  const won = list.filter((a) => a.status === 'closed' && (a.won === true || a.finalUsRank === 1)).length;
  let lede;
  if (open.length) {
    lede = 'Bidding on <b>' + open.length + '</b> live auction' + (open.length > 1 ? 's' : '') +
      ' &mdash; winning <b>' + winning + '</b>, never below your floor.';
  } else if (list.length) {
    lede = 'Done. Won <b>' + won + '</b> of ' + list.length + '.';
  } else {
    lede = 'Connected. No live auctions right now.';
  }
  $('#lede').innerHTML = lede;

  // cards (keyed reconcile)
  const cardsEl = $('#cards'); const seen = new Set();
  for (const a of list) {
    seen.add(a.id);
    let c = cards.get(a.id);
    if (!c) { c = buildCard(a); cards.set(a.id, c); cardsEl.appendChild(c.el); }
    updateCard(c, a);
  }
  for (const [id, c] of cards) if (!seen.has(id)) { c.el.remove(); cards.delete(id); }

  if (!list.length) {
    if (!$('#emptyMsg')) {
      const e = document.createElement('p'); e.id = 'emptyMsg'; e.className = 'empty';
      e.textContent = 'No live auctions. Click "Run demo" to see it in action.';
      cardsEl.appendChild(e);
    }
  } else { const e = $('#emptyMsg'); if (e) e.remove(); }
}

/* countdown ticker (smooth between polls) */
setInterval(() => {
  for (const c of cards.values()) {
    if (!c.closesAtLocal) continue;
    const cd = c.el.querySelector('.cd');
    if (cd) cd.textContent = mmss(c.closesAtLocal - Date.now());
  }
}, 250);

/* ---- polling ---- */
let polling = false, MODE = 'demo';
async function poll() {
  try { const s = await api('GET', '/api/state'); render(s); } catch (e) { /* keep last view */ }
}
function startPolling() { if (polling) return; polling = true; poll(); setInterval(poll, 700); }

/* ---- LIVE mode (real SuperProcure account, read-only) ---- */
const fmtIST = (iso) => { try { return new Date(iso).toLocaleString('en-IN',
  { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }); } catch (_) { return '—'; } };
function humanDur(ms) {
  if (ms <= 0) return 'now'; const m = Math.round(ms / 60000); if (m < 60) return m + ' min';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
function liveCard(l, serverNow) {
  let st = l.status, badgeKind = 'idle', badgeTxt = 'Scheduled', cd = '';
  if (l.status === 'closed') { badgeTxt = 'Closed'; cd = 'auction ended'; }
  else if (l.status === 'live') { badgeKind = 'winning'; badgeTxt = 'Live now'; cd = 'closes in ' + humanDur(l.closesAt - serverNow); }
  else { cd = 'starts in ' + humanDur(l.startsAt - serverNow); }
  const prod = l.productName ? ' · ' + l.productName : '';
  // full pickup/drop addresses when the load carries them (real /sp/loads/v4 loads do);
  // block display + overflow-wrap so a long drop address wraps inside the card.
  const pts = Array.isArray(l.points) ? l.points.filter((p) => p && p.address) : [];
  const ptsHtml = pts.map((p) =>
    `<div class="meta" style="display:block;overflow-wrap:anywhere">${p.kind === 'pickup' ? 'Pickup' : 'Drop'}: ${esc(p.address)}</div>`).join('');
  return `<article class="card" data-win="${l.status === 'live' ? 1 : 0}">
    <div class="card-head">
      <div><div class="lane"><span>${l.lane.origin}</span><span class="arrow">&rarr;</span><span>${l.lane.destination}</span></div>
      <div class="meta">${l.equipment} <span class="dot"></span> ${l.units} ${l.units > 1 ? 'vehicles' : 'vehicle'} <span class="dot"></span> ${l.shipmentType} <span class="dot"></span> ${l.companyName}${prod}</div>${ptsHtml}</div>
      <span class="badge" data-kind="${badgeKind}">${badgeTxt}</span>
    </div>
    <div class="figs">
      <div class="fig"><div class="fig-label">Auction window (IST)</div>
        <div class="fig-val" style="font-size:14px;line-height:1.45">${fmtIST(l.biddingStartTime)}<br>&rarr; ${fmtIST(l.biddingCloseTime)}</div>
        <div class="fig-sub">${cd}</div></div>
      <div class="fig"><div class="fig-label">Bid difference</div>
        <div class="fig-val">${money(l.minDecrement)}</div>
        <div class="fig-sub">${l.revisionLimit || '?'} revisions · ${l.showL1Rate ? 'rank + L1 shown' : 'rank only'}${l.softClose ? ' · anti-snipe' : ''}</div></div>
    </div>
    <div class="status"><span class="sdot"></span>read-only &mdash; bidding not armed</div>
  </article>`;
}
function renderLive(s) {
  const acct = s.account || {};
  $('#lede').innerHTML = `<b>${acct.user || acct.company || 'Your account'}</b> &mdash; ${s.loads.length} auction load${s.loads.length !== 1 ? 's' : ''} on your live SuperProcure account. <span style="color:var(--muted)">read-only</span>`;
  const cardsEl = $('#cards');
  if (!s.loads.length) { cardsEl.innerHTML = '<p class="empty">No auction loads in the current window.</p>'; return; }
  const order = { live: 0, scheduled: 1, closed: 2 };
  const sorted = [...s.loads].sort((a, b) => (order[a.status] - order[b.status]) || (a.closesAt - b.closesAt));
  cardsEl.innerHTML = sorted.map((l) => liveCard(l, s.serverNow)).join('');
}
let livePolling = false;
async function pollLive() { try { const s = await api('GET', '/api/live-state'); if (s.connected) renderLive(s); } catch (_) {} }
function startLivePolling() { if (livePolling) return; livePolling = true; pollLive(); setInterval(pollLive, 5000); }

/* ---- connect / actions ---- */
function setConnected(label) {
  const conn = $('#conn'); conn.dataset.state = 'connected'; $('#connText').textContent = label;
}
function showBoard() { $('#gate').hidden = true; $('#board').hidden = false; }

async function enter(demo) {
  showBoard(); startPolling();
  await api('POST', '/api/demo/seed');
}

$('#connectBtn').addEventListener('click', async () => {
  const btn = $('#connectBtn');
  const tok = $('#tokenInput').value.trim();
  if (!tok) { toast('Paste a token, or use demo data below.'); return; }
  btn.disabled = true; btn.textContent = 'Connecting…';
  try {
    const r = await api('POST', '/api/connect', { token: tok });
    if (r && r.connected) {
      MODE = 'live';
      setConnected('Connected · ' + (r.account.user || r.account.company || 'SuperProcure'));
      $('#runBtn').textContent = 'Refresh'; $('#resetBtn').textContent = 'Disconnect';
      showBoard(); startLivePolling();
      toast('Connected to your live SuperProcure account (read-only).');
    } else { toast((r && r.error) || 'Connect failed.'); }
  } catch (e) { toast('Connect failed.'); }
  btn.disabled = false; btn.textContent = 'Connect account';
});
$('#demoBtn').addEventListener('click', async () => {
  MODE = 'demo';
  setConnected('Demo data');
  await enter(true);
});
$('#runBtn').addEventListener('click', () => { if (MODE === 'live') pollLive(); else api('POST', '/api/demo/seed'); });
$('#resetBtn').addEventListener('click', async () => {
  if (MODE === 'live') { location.reload(); return; }
  await api('POST', '/api/sim/reset');
  for (const [id, c] of cards) { c.el.remove(); cards.delete(id); }
  poll();
});
