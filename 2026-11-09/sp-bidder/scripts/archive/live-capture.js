'use strict';
/**
 * Unattended LIVE auction capture (READ-ONLY). Meant to be run by a Windows
 * scheduled task during a real auction window. Authenticates the SPA, opens the
 * marketplace, and records the socket.io live frames + data-API calls for
 * CAPTURE_MIN minutes so we can decode the live rank/countdown/new-bid messages.
 *
 * SAFETY: never submits a quote; a request guard aborts any bid-write. Token
 * redacted from disk. Output -> data/recon/live/<timestamp>.json (gitignored).
 *
 * Usage: node scripts/live-capture.js [minutes]
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const COOKIE_FILE = process.env.COOKIE_FILE || 'C:\\Users\\sidro\\Downloads\\app.superprocure.com_cookies.txt';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CAPTURE_MIN = Number(process.argv[2] || process.env.CAPTURE_MIN || 25);
const OUTDIR = path.join(__dirname, '..', '..', 'data', 'recon', 'live');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BID_WRITE_RE = /(submit|place|award|revise|accept|confirm|finalize|createTrip|bidVehicle).*(bid|quote|rate|vehicle|trip)|quotePerVehicle|placeBid|bidVehicle/i;

function token() { for (const l of fs.readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/)) { if (l.startsWith('#') || !l.trim()) continue; const p = l.split('\t'); if (p[5] === 'token') return p[6]; } }
function parseCookies() { const out = []; for (const l of fs.readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/)) { if (l.startsWith('#') || !l.trim()) continue; const p = l.split('\t'); if (p.length < 7) continue; const c = { name: p[5], value: p[6], domain: p[0], path: p[2], secure: p[3] === 'TRUE', httpOnly: false }; if (Number(p[4]) > 0) c.expires = Number(p[4]); out.push(c); } return out; }

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const tok = token();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(OUTDIR, `live-${stamp}.json`);
  const redact = (s) => (typeof s === 'string' && tok ? s.split(tok).join('[REDACTED]') : s);
  const log = { startedAt: new Date().toISOString(), captureMin: CAPTURE_MIN, ws: [], api: [], aborted: [] };
  const save = () => fs.writeFileSync(outFile, JSON.stringify(log, null, 2));

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.evaluateOnNewDocument((t) => { if (location.hostname === 'app.superprocure.com') { try {
    localStorage.setItem('authToken', t); localStorage.setItem('authHeader', 'Bearer ' + t);
    localStorage.setItem('signedOut', 'false'); localStorage.setItem('uid', '32468'); localStorage.setItem('company', '10686'); } catch (e) {} } }, tok);
  await page.setCookie(...parseCookies());

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const m = req.method(), u = req.url();
    if (WRITE_METHODS.has(m) && /superprocure/i.test(u) && BID_WRITE_RE.test(u)) { log.aborted.push({ at: Date.now(), m, path: u.replace(/https?:\/\/[^/]+/, '') }); return req.abort(); }
    req.continue();
  });
  page.on('response', async (res) => {
    try { const req = res.request(), u = res.url();
      if (!/superprocure\.com/i.test(u) || !['xhr', 'fetch'].includes(req.resourceType())) return;
      const ct = res.headers()['content-type'] || ''; let body = '';
      try { if (/json/i.test(ct)) body = await res.text(); } catch (_) {}
      log.api.push({ at: Date.now(), method: req.method(), path: u.replace(/https?:\/\/[^/]+/, '').split('?')[0], status: res.status(), body: body ? redact(body).slice(0, 8000) : null });
    } catch (_) {}
  });

  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', ({ url }) => log.ws.push({ at: Date.now(), type: 'open', url: redact(url) }));
  const onFrame = (dir) => ({ response }) => { const p = response && response.payloadData ? String(response.payloadData) : '';
    if (p && !/^\d+$/.test(p)) log.ws.push({ at: Date.now(), type: 'frame', dir, data: redact(p).slice(0, 1200) }); };
  cdp.on('Network.webSocketFrameReceived', onFrame('recv'));
  cdp.on('Network.webSocketFrameSent', onFrame('sent'));

  const CAP_URL = process.env.CAPTURE_URL || 'https://app.superprocure.com/loadBoard?tab=open';
  console.log(`[live-capture] starting ${CAPTURE_MIN}min PASSIVE capture of ${CAP_URL} -> ${outFile}`);
  await page.goto(CAP_URL, { waitUntil: 'networkidle2', timeout: 60000 }).catch((e) => console.log('nav:', e.message));
  log.authed = !/auth\./.test(page.url());
  console.log('[live-capture] authed:', log.authed);

  const until = Date.now() + CAPTURE_MIN * 60_000;
  while (Date.now() < until) {
    await sleep(30_000);
    save();
    // nudge a refresh so new bids/loads are re-fetched while we watch
    await page.reload({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
    console.log(`[live-capture] ws frames=${log.ws.filter((f) => f.type === 'frame').length} api=${log.api.length} (${Math.round((until - Date.now()) / 60000)}min left)`);
  }
  save();
  await browser.close();
  console.log('[live-capture] done.');
  process.exit(0);
})().catch((e) => { console.error('[live-capture] failed:', e.message); process.exit(1); });
