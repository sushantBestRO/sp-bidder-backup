'use strict';
/**
 * Pretty capture/track links: a readable "<shipper>-<closeDate>-<token>" slug in front of the
 * opaque token (Notion-style). The slug is COSMETIC - the token is still the only thing that
 * resolves. Asserts:
 *   - the token is base62, 11 chars, unique (the shortened link ending, ~65 bits);
 *   - publicSeg round-trips: tokenFromPath(publicSeg(req)) === req.id, with or without a slug;
 *   - the live router accepts the pretty URL on /price, /track and their /state pollers, and a
 *     bare token (old links) still works; a real token behind a WRONG slug still resolves, and a
 *     bad token 404s regardless of the slug.
 * Boots the app in mock mode over the memory store on an ephemeral port.
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-link-slug-'));

const http = require('http');
const { app, requests, customerStore } = require('../src/web/server');
const { publicSeg, tokenFromPath, linkSlug } = require('../src/pricing/priceRequests');
const { renderMessage } = require('../src/notify/waTemplates');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

function req(method, url, { body = null, contentType = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType || 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

const B62 = /^[0-9A-Za-z]{11}$/;

(async () => {
  // ---- token shape + uniqueness (the shortened ending) --------------------------------------
  const now = Date.now();
  const made = [];
  for (let i = 0; i < 24; i++) {
    made.push(await requests.createForLoad({
      id: `SLUG-${i}`, lane: { origin: 'Bhiwandi', destination: 'Bawal' }, equipment: '32ft', units: 1,
      companyName: 'Syngenta India Pvt Ltd', closesAt: now + 10 * 60_000, startsAt: now - 60_000, status: 'live',
    }));
  }
  ok(made.every((r) => B62.test(r.id)), 'token is base62 and exactly 11 chars');
  ok(made.every((r) => !r.id.includes('-')), 'token carries no "-" (so the slug delimiter is unambiguous)');
  ok(new Set(made.map((r) => r.id)).size === made.length, 'tokens are unique across draws');

  // ---- publicSeg / tokenFromPath round-trip (the core invariant) -----------------------------
  const rt = (r) => tokenFromPath(publicSeg(r)) === r.id;
  const withSlug = made[0];
  ok(publicSeg(withSlug).startsWith('syngenta-india-'), 'slug uses the first ~2 words of the shipper name');
  ok(publicSeg(withSlug).endsWith(withSlug.id), 'the token is the tail of the pretty segment');
  ok(rt(withSlug), 'round-trip: tokenFromPath(publicSeg(withSlug)) === token');

  // load with nothing slug-able -> segment IS just the bare token
  const bare = { id: 'AbC012xyz89', load: {} };
  ok(publicSeg(bare) === bare.id && rt(bare), 'no shipper/close -> segment is the bare token (still round-trips)');

  // punctuation / multi-word shipper stays a clean slug and still round-trips
  const punct = { id: 'Zz9Yy8Xx7Ww', load: { companyName: 'M/s. Reliance & Co.', closesAt: now } };
  ok(/^[a-z0-9-]+$/.test(linkSlug(punct)) && rt(punct), 'punctuated shipper -> clean slug, still round-trips');

  // ---- the customer snapshot beats the raw platform string in the slug -----------------------
  // SP company strings like "BG (BorosilLimited(Govindgarh))" made links read "bg-borosillimited-";
  // a request carrying the model tag (createForLoad's resolveCustomerTag) links by the clean
  // customerId instead. No tag (legacy request / no match) -> the raw-derived slug, unchanged.
  const rawName = 'BG (BorosilLimited(Govindgarh))';
  const tagged = { id: 'Qq1Ww2Ee3Rr', load: { companyName: rawName, closesAt: now }, customer: { customerId: 'borosil', label: 'Borosil' } };
  ok(linkSlug(tagged).startsWith('borosil-') && rt(tagged), 'customer-tagged request links by the clean customerId slug');
  ok(!linkSlug(tagged).includes('bg'), 'the raw "BG..." fragment is gone from a tagged link');
  const untagged = { id: 'Qq1Ww2Ee3Rs', load: { companyName: rawName, closesAt: now } };
  ok(linkSlug(untagged).startsWith('bg-borosillimited') && rt(untagged), 'untagged request keeps the raw-derived slug (compat)');

  // ---- branch segment: multi-branch shippers get a de-stuttered branch in the slug -----------
  // SP carries the consignor branch as its own field (branchName). Multi-branch shippers share
  // ONE companyName/customerId, so the branch is what tells REN-K from REN-H, or Ashirvad-Bhiwadi
  // from Ashirvad-Kolkata, apart in a capture link. The branch token is de-stuttered against the
  // customer slug already in the URL: "renewsys" + "REN-K" -> "renewsys-k", never "renewsys-ren-k".
  const brSlug = (customerId, branchName, id = 'Br0nch00000') =>
    linkSlug({ id, load: { companyName: customerId, branchName, closesAt: now }, customer: { customerId } });
  ok(brSlug('renewsys', 'REN-K').startsWith('renewsys-k-'), 'Renewsys REN-K -> renewsys-k (shipper prefix de-stuttered)');
  ok(brSlug('renewsys', 'REN-H').startsWith('renewsys-h-'), 'Renewsys REN-H -> renewsys-h');
  ok(!brSlug('renewsys', 'REN-K').includes('renewsys-ren'), 'the repeated "ren" is dropped, not doubled');
  ok(brSlug('ashirvad', 'Bhiwadi- Plant').startsWith('ashirvad-bhiwadi-plant-'), 'Ashirvad "Bhiwadi- Plant" -> ashirvad-bhiwadi-plant (no false overlap)');
  ok(brSlug('ashirvad', 'Kolkata- Panchla DC').startsWith('ashirvad-kolkata-panchla-dc-'), 'Ashirvad multi-word branch kept (capped at 3 tokens)');
  ok(brSlug('epack', 'Epack Noida').startsWith('epack-noida-') && !brSlug('epack', 'Epack Noida').includes('epack-epack'), 'Epack Noida -> epack-noida (repeated shipper name dropped)');
  ok(brSlug('shriji-polymers', 'U Shriji Polymers').startsWith('shriji-polymers-u-'), 'Shriji "U Shriji Polymers" -> shriji-polymers-u (name repeat dropped, "u" kept)');
  ok(brSlug('havells', 'Alwar Cable (1350)').startsWith('havells-alwar-cable-1350-'), 'Havells "Alwar Cable (1350)" -> havells-alwar-cable-1350');
  ok(brSlug('kei', 'Chopanki').startsWith('kei-chopanki-'), 'KEI Chopanki -> kei-chopanki (short customer, no spurious strip)');

  // absent branch -> slug unchanged (exactly one segment fewer than the single-token branched form)
  const noBr = linkSlug({ id: 'Br0nch00001', load: { companyName: 'renewsys', closesAt: now }, customer: { customerId: 'renewsys' } });
  ok(noBr.startsWith('renewsys-') && !noBr.startsWith('renewsys-k'), 'no branchName -> no branch segment');
  ok(brSlug('renewsys', 'REN-K').split('-').length === noBr.split('-').length + 1, 'a single-token branch adds exactly one slug segment');

  // de-stutter that would empty the branch (branchName == the customer) falls back, never empty
  const selfBr = linkSlug({ id: 'Br0nch00002', load: { companyName: 'renewsys', branchName: 'Renewsys', closesAt: now }, customer: { customerId: 'renewsys' } });
  ok(selfBr.split('-').length >= 3, 'branch == customer -> falls back to full branch slug, never an empty segment');

  // the branch segment still round-trips (token is the tail)
  const brReq = { id: 'Br0nchToken', load: { companyName: 'renewsys', branchName: 'REN-K', closesAt: now }, customer: { customerId: 'renewsys' } };
  ok(publicSeg(brReq).startsWith('renewsys-k-') && tokenFromPath(publicSeg(brReq)) === brReq.id, 'branch slug round-trips: token is still the tail');

  // WA price_needed *Name*: display prefers the clean label (shipperName); the raw string
  // stays the routing key and the fallback when no customer matched.
  const waTagged = renderMessage('price_needed', { shipper: rawName, shipperName: 'Borosil', link: 'L' });
  ok(waTagged.includes('*Borosil*') && !waTagged.includes('BorosilLimited'), 'price_needed renders the clean label, not the raw platform string');
  const waPlain = renderMessage('price_needed', { shipper: rawName, link: 'L' });
  ok(waPlain.includes(rawName), 'no shipperName -> price_needed falls back to the raw name');

  // The minimal ask HEADER names the branch for a multi-branch shipper: "<shipper> · <branch>"
  // (middle-dot separator). The routing key stays the plain shipper; absent branch leaves it unchanged.
  const waBranch = renderMessage('price_needed', { shipper: 'Renewsys India', shipperName: 'Renewsys India', branch: 'REN-K', link: 'L' });
  ok(waBranch.includes('📩 *Renewsys India · REN-K*'), 'price_needed header appends the SP branch label as "CUSTOMER · BRANCH" (middle dot)');
  const waNoBranch = renderMessage('price_needed', { shipper: 'Renewsys India', shipperName: 'Renewsys India', link: 'L' });
  ok(waNoBranch.includes('📩 *Renewsys India*') && !waNoBranch.includes('Renewsys India ·'), 'no branch -> header has no branch separator');

  // parser basics: bare token unchanged, empty stays empty
  ok(tokenFromPath('AbC012xyz89') === 'AbC012xyz89', 'bare token (no dash) returns unchanged');
  ok(tokenFromPath('') === '' && tokenFromPath(null) === '', 'empty / null path -> empty token');

  // ---- live router accepts the pretty URL, the bare token, and a wrong slug -------------------
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => req('GET', base + p);
  const postForm = (p, kv) => req('POST', base + p, { body: new URLSearchParams(kv).toString(), contentType: 'application/x-www-form-urlencoded' });

  const r0 = made[1];
  const seg = publicSeg(r0);
  ok(seg.includes('-') && seg !== r0.id, 'sanity: this request DID get a slug prefix');

  ok((await get(`/price/${seg}`)).status === 200, 'GET /price/<slug>-<token> renders the form');
  ok((await get(`/track/${seg}`)).status === 200, 'GET /track/<slug>-<token> renders the track page');
  ok((await get(`/price/${seg}/state`)).status === 200, 'GET /price/<slug>-<token>/state serves (poller path)');
  ok((await get(`/track/${seg}/state`)).status === 200, 'GET /track/<slug>-<token>/state serves (poller path)');
  ok((await get(`/price/${r0.id}`)).status === 200, 'GET /price/<bare-token> still works (old links)');

  // a real token behind a DIFFERENT slug still resolves (slug is not authoritative)
  ok((await get(`/price/totally-wrong-slug-${r0.id}`)).status === 200, 'wrong slug + real token still resolves');
  // a bad token 404s no matter how nice the slug looks
  ok((await get(`/price/syngenta-8jul-notarealtok`)).status === 404, 'nice slug + bad token -> 404');

  // ---- end-to-end: a seeded Customer tags the request and cleans the live link ---------------
  // The model resolves "BG (BorosilLimited(Govindgarh))" -> the Borosil customer (word-boundary
  // alias match, same matchCustomer the margin path uses); the created request carries the tag,
  // the pretty URL leads with the clean slug, and the /price page names the label.
  await customerStore.upsert({ label: 'Borosil', aliases: ['BG', 'BorosilLimited'] });
  const rB = await requests.createForLoad({
    id: 'SLUG-BORO', lane: { origin: 'Jaipur', destination: 'Bhiwandi' }, equipment: '32ft', units: 1,
    companyName: rawName, closesAt: now + 10 * 60_000, startsAt: now - 60_000, status: 'live',
  });
  ok(!!rB.customer && rB.customer.customerId === 'borosil' && rB.customer.label === 'Borosil', 'createForLoad snapshots the matched customer tag');
  const segB = publicSeg(rB);
  ok(segB.startsWith('borosil-') && tokenFromPath(segB) === rB.id, 'live capture link leads with the clean customer slug');
  const pageB = await get(`/price/${segB}`);
  ok(pageB.status === 200 && pageB.text.includes('Borosil') && !pageB.text.includes('BorosilLimited(Govindgarh)'), '/price page shows the clean label, not the raw platform string');

  // end-to-end: a load carrying branchName snapshots it, de-stutters the link, and names the
  // branch on the /price page header (no customer seeded -> slug falls out of the raw companyName).
  const rBr = await requests.createForLoad({
    id: 'SLUG-RENK', lane: { origin: 'Chakan', destination: 'Hosur' }, equipment: '32ft', units: 1,
    companyName: 'Renewsys India', branchName: 'REN-K', closesAt: now + 10 * 60_000, startsAt: now - 60_000, status: 'live',
  });
  ok(rBr.load.branchName === 'REN-K', 'createForLoad snapshots branchName onto the request');
  const segBr = publicSeg(rBr);
  ok(segBr.includes('-k-') && tokenFromPath(segBr) === rBr.id, 'live link carries the de-stuttered branch and round-trips');
  const pageBr = await get(`/price/${segBr}`);
  ok(pageBr.status === 200 && pageBr.text.includes('(REN-K)'), '/price page header names the branch');

  // POST through the pretty URL captures against the real token
  const p = await postForm(`/price/${seg}`, { cost: '80000' });
  ok(p.status === 200 && /Cost saved/.test(p.text), 'POST /price/<slug>-<token> captures the cost');
  const after = await requests.getByToken(r0.id);
  ok(after && after.status === 'armed' && after.price && after.price.cost === 80000, 'capture landed on the real token doc');

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
