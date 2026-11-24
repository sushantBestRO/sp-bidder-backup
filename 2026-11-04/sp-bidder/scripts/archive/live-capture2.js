'use strict';
/**
 * Live capture v2 (READ-ONLY) — opens a LOAD's bidding view so we join its
 * per-load socket room and capture the live rank/bid/countdown events (the list
 * page only gets the `current` heartbeat). Clicks "Quote Per Vehicle" to open the
 * bid view but NEVER submits; the request guard aborts any bid-write.
 *
 * Usage: node scripts/live-capture2.js [seconds]
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const COOKIE_FILE = process.env.COOKIE_FILE || 'C:\\Users\\sidro\\Downloads\\app.superprocure.com_cookies.txt';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SECS = Number(process.argv[2] || 70);
const OUTDIR = path.join(__dirname, '..', '..', 'data', 'recon', 'live');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BID_WRITE_RE = /(submit|place|award|revise|accept|confirm|finalize|createTrip|bidVehicle).*(bid|quote|rate|vehicle|trip)|quotePerVehicle|placeBid|bidVehicle|saveBid/i;
function token() { for (const l of fs.readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/)) { if (l.startsWith('#') || !l.trim()) continue; const p = l.split('\t'); if (p[5] === 'token') return p[6]; } }
function cookies() { const o = []; for (const l of fs.readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/)) { if (l.startsWith('#') || !l.trim()) continue; const p = l.split('\t'); if (p.length < 7) continue; const c = { name: p[5], value: p[6], domain: p[0], path: p[2], secure: p[3] === 'TRUE', httpOnly: false }; if (Number(p[4]) > 0) c.expires = Number(p[4]); o.push(c); } return o; }

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const tok = token();
  const redact = (s) => (typeof s === 'string' && tok ? s.split(tok).join('[REDACTED]') : s);
  const out = path.join(OUTDIR, `loadview-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const rec = { startedAt: new Date().toISOString(), ws: [], api: [], aborted: [], opened: null };
  const save = () => fs.writeFileSync(out, JSON.stringify(rec, null, 2));

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.evaluateOnNewDocument((t) => { if (location.hostname === 'app.superprocure.com') { try { localStorage.setItem('authToken', t); localStorage.setItem('authHeader', 'Bearer ' + t); localStorage.setItem('signedOut', 'false'); localStorage.setItem('uid', '32468'); localStorage.setItem('company', '10686'); } catch (e) {} } }, tok);
  await page.setCookie(...cookies());

  await page.setRequestInterception(true);
  page.on('request', (req) => { const m = req.method(), u = req.url();
    if (WRITE_METHODS.has(m) && /superprocure/i.test(u) && BID_WRITE_RE.test(u)) { rec.aborted.push({ at: Date.now(), m, path: u.replace(/https?:\/\/[^/]+/, '') }); console.log('[BLOCKED write]', m, u.replace(/https?:\/\/[^/]+/, '')); return req.abort(); }
    req.continue(); });
  page.on('response', async (res) => { try { const req = res.request(), u = res.url(); if (!/superprocure\.com/i.test(u) || !['xhr', 'fetch'].includes(req.resourceType())) return; const ct = res.headers()['content-type'] || ''; let b = ''; try { if (/json/i.test(ct)) b = await res.text(); } catch (_) {} rec.api.push({ at: Date.now(), method: req.method(), path: u.replace(/https?:\/\/[^/]+/, '').split('?')[0], status: res.status(), body: b ? redact(b).slice(0, 6000) : null }); } catch (_) {} });

  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');
  const onFrame = (dir) => ({ response }) => { const p = response && response.payloadData ? String(response.payloadData) : ''; if (p && !/^\d+$/.test(p)) { rec.ws.push({ at: Date.now(), dir, data: redact(p).slice(0, 1500) });
    const m = p.match(/^42(\[.*)/s); if (m) { try { const a = JSON.parse(m[1]); if (a[0] !== 'current') console.log(`  [socket ${dir}] ${a[0]}: ${JSON.stringify(a.slice(1)).slice(0, 160)}`); } catch (_) {} } } };
  cdp.on('Network.webSocketFrameReceived', onFrame('recv'));
  cdp.on('Network.webSocketFrameSent', onFrame('sent'));

  console.log('[v2] loading marketplace...');
  await page.goto('https://app.superprocure.com/marketplace', { waitUntil: 'networkidle2', timeout: 60000 }).catch((e) => console.log('nav:', e.message));
  await sleep(4000);

  // Keep trying to open a LIVE load's bidding view (read-only) to join its socket
  // room. The "Quote Per Vehicle" control only appears once an auction is live.
  const tryOpen = () => page.evaluate(() => {
    const norm = (t) => (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const cand = [...document.querySelectorAll('button, a, [role=button]')]
      .filter((e) => e.offsetParent !== null && !e.disabled);
    const btn = cand.find((e) => norm(e.textContent) === 'quote per vehicle')
      || cand.find((e) => /^quote per vehicle/.test(norm(e.textContent)) && norm(e.textContent).length < 30);
    if (btn) { btn.click(); return norm(btn.textContent).slice(0, 30); }
    return null;
  });

  const until = Date.now() + SECS * 1000;
  let opened = false;
  while (Date.now() < until) {
    if (!opened) {
      const clicked = await tryOpen().catch(() => null);
      if (clicked) { opened = true; rec.opened = clicked; rec.openedAt = Date.now(); console.log('[v2] OPENED a live load bid view ->', clicked); await sleep(3000); }
    }
    await sleep(15000);
    save();
    const evs = rec.ws.filter((f) => /^42\["(?!current)/.test(f.data)).length;
    console.log(`[v2] opened=${opened} non-heartbeat-events=${evs} api=${rec.api.length} (${Math.round((until - Date.now()) / 60000)}min left) url=${page.url().replace('https://app.superprocure.com', '')}`);
    if (!opened) await page.reload({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {}); // refresh list until a load goes live
  }
  rec.landedUrl = page.url();
  save();
  await browser.close();
  const evs = rec.ws.filter((f) => /^42/.test(f.data)).map((f) => { try { return JSON.parse(f.data.slice(2))[0]; } catch (_) { return '?'; } });
  const counts = {}; for (const e of evs) counts[e] = (counts[e] || 0) + 1;
  console.log('\n[v2] done. socket events:', JSON.stringify(counts), '| api:', rec.api.length, '| aborted:', rec.aborted.length, '| url:', rec.landedUrl);
  console.log('saved ->', out);
  process.exit(0);
})().catch((e) => { console.error('[v2] failed:', e.message); process.exit(1); });
