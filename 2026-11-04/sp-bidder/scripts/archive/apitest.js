'use strict';
/**
 * Read-only API auth/shape test against the data API (api.superprocure.com/sp/...).
 * GET only, curated to NON-WRITE endpoints. Confirms the token authenticates the
 * data API and reveals response shapes for the adapter. No bid is placed.
 * Token never printed; response values not printed (only top-level key names).
 */
const fs = require('fs');
const COOKIE_FILE = process.env.COOKIE_FILE || 'C:\\Users\\sidro\\Downloads\\app.superprocure.com_cookies.txt';

function token() {
  for (const line of fs.readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('#') || !line.trim()) continue;
    const p = line.split('\t'); if (p[5] === 'token') return p[6];
  }
}
const T = token();

const HOST = 'https://api.superprocure.com';
// READ-only endpoints only. Deliberately NO bidVehicle/createTrip/createLoad/save*.
const READ = [
  '/sp/loads/getOpenLoadCount',
  '/sp/loads/loadBoardDetails',
  '/sp/loads/getLoadDetailsMasterData',
  '/sp/fleetManagement/getVehicleList',
  '/sp/vehicleTypes/getVehicleBodyTypes',
  '/sp/lane/laneCodes',
  '/sp/contract/loadingPatterns',
  '/loadBoard',
];

async function hit(p) {
  const headers = { 'user-agent': 'Mozilla/5.0', accept: 'application/json',
    cookie: 'token=' + T, authorization: 'Bearer ' + T };
  try {
    const res = await fetch(HOST + p, { method: 'GET', headers, redirect: 'manual' });
    const ct = res.headers.get('content-type') || '';
    let keys = '', msg = '';
    if (/json/i.test(ct)) {
      try {
        const j = await res.json();
        msg = (j && typeof j.message === 'string') ? j.message.slice(0, 40) : '';
        const d = j && j.data != null ? j.data : j;
        const root = Array.isArray(d) ? (d[0] || {}) : d;
        keys = (Array.isArray(d) ? '[array of] ' : '') + Object.keys(root || {}).slice(0, 14).join(',');
      } catch (_) {}
    }
    return { status: res.status, ct: ct.split(';')[0], keys, msg };
  } catch (e) { return { status: 'ERR', err: e.code || e.message }; }
}

(async () => {
  console.log('read-only data-API test (api.superprocure.com/sp/...)\n');
  for (const p of READ) {
    const r = await hit(p);
    const tag = r.status === 200 ? 'OK ' : (r.status === 401 || r.status === 403 ? 'AUTH' : '   ');
    console.log(`${tag} ${String(r.status).padEnd(5)} GET ${p}`);
    if (r.msg) console.log(`        message: "${r.msg}"`);
    if (r.keys) console.log(`        data keys: ${r.keys}`);
  }
})();
