'use strict';
/* BidPilot price-request worklist. Polls /api/price-requests and shows the loads
   the bot has discovered that need a cost from the pricing team, with the capture
   link to send. The dashboard-worklist surface of the notifier (the default channel). */

const $ = (s) => document.querySelector(s);
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const money = (n) => (n == null ? '—' : inr.format(Math.round(n)));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => (t.hidden = true), 260); }, 2600);
}

function dur(ms) {
  if (ms == null) return '—';
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60000);
  return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

const STATUS = {
  awaiting_price:   { txt: 'Needs a number', cls: 'b-await' },
  armed:            { txt: 'Armed · dry-run', cls: 'b-armed' },
  skipped_no_price: { txt: 'Skipped — no number', cls: 'b-skip' },
  closed:           { txt: 'Closed', cls: 'b-closed' },
};
const ORDER = { awaiting_price: 0, armed: 1, skipped_no_price: 2, closed: 3 };

let baseUrl = '';

function row(r) {
  const L = r.load || {};
  const lane = L.lane ? `<span>${esc(L.lane.origin)}</span><span class="arrow">&rarr;</span><span>${esc(L.lane.destination)}</span>` : '?';
  const s = STATUS[r.status] || { txt: r.status, cls: 'b-closed' };
  const link = (baseUrl || '') + '/price/' + (r.pathSeg || r.id); // pretty slug+token from the API
  const closes = L.closesAt ? 'closes ' + dur(L.closesAt - Date.now()) : '';
  const metaBits = [esc(L.companyName), esc(L.equipment) + (L.units ? ' &times; ' + L.units : ''), esc(L.productName), closes, L.softClose ? 'soft close' : '']
    .filter(Boolean).join(' <span class="dot"></span> ');
  // full pickup/drop addresses (drop especially - the exact point the price hinges on).
  // Only real loads carry them; sim loads fall back to the lane line above.
  const pts = Array.isArray(L.points) ? L.points.filter((p) => p && p.address) : [];
  const ptsHtml = pts.length ? `<div class="wl-pts">${pts.map((p) =>
    `<div class="wl-pt"><b>${p.kind === 'pickup' ? 'Pickup' : 'Drop'}:</b> ${esc(p.address)}</div>`).join('')}</div>` : '';
  // shipper-attached context (rendered only when the load carries it): the note text
  // (plain text in the snapshot) + a hint when the portal holds comments/attachments.
  const portalBits = [L.hasPortalComments ? 'comments' : null, L.hasPortalAttachments ? 'attachments' : null].filter(Boolean).join(' and ');
  const shipNote = (L.notes ? `<div class="wl-shipnote"><b>Shipper note:</b> ${esc(L.notes)}</div>` : '') +
    (portalBits ? `<div class="wl-note">This load ${L.notes ? 'also ' : ''}has ${portalBits} on the SuperProcure portal.</div>` : '');

  let side = `<span class="badge2 ${s.cls}">${s.txt}</span>`;
  if (r.status === 'awaiting_price') {
    const left = r.deadlineAt ? `enter within <b>${dur(r.deadlineAt - Date.now())}</b>` : '';
    side += `<div class="wl-act"><a class="btn2" href="${esc(link)}" target="_blank" rel="noopener">Open</a>` +
            `<button class="btn2 ghost" data-copy="${esc(link)}">Copy link</button></div>` +
            (left ? `<div class="wl-note">${left}</div>` : '');
  } else if (r.status === 'armed' && r.price) {
    side += `<div class="wl-note">cost <b>${money(r.price.cost)}</b> &middot; band ${esc((r.price.marginsPct || []).join('/'))}%</div>`;
  }

  return `<article class="wl-row" data-status="${r.status}">
    <div class="wl-main"><div class="lane">${lane}</div><div class="meta">${metaBits}</div>${ptsHtml}${shipNote}</div>
    <div class="wl-side">${side}</div>
  </article>`;
}

function render(data) {
  baseUrl = data.baseUrl || baseUrl;
  const reqs = data.requests || [];
  const awaiting = reqs.filter((r) => r.status === 'awaiting_price').length;
  const armed = reqs.filter((r) => r.status === 'armed').length;
  $('#lede').innerHTML = reqs.length
    ? `<b>${awaiting}</b> need a number &middot; <b>${armed}</b> armed &middot; ${reqs.length} total`
    : 'No price requests yet. A request opens per in-scope load discovered; enter the cost here or from the WhatsApp link.';
  const sorted = [...reqs].sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || ((a.deadlineAt || 0) - (b.deadlineAt || 0)));
  $('#list').innerHTML = sorted.map(row).join('') || '<p class="empty">No price requests yet.</p>';
}

async function poll() { try { render(await api('GET', '/api/price-requests')); } catch (_) { /* keep last view */ } }

$('#list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (b) { navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Capture link copied')).catch(() => toast(b.dataset.copy)); }
});

poll();
setInterval(poll, 2500);
