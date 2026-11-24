'use strict';
/**
 * The write-once close snapshot, refreshed from live listing state on a portal whose posted close
 * is provisional.
 *
 * THE DEFECT. priceRequests persists load.closesAt once, at discovery, and never refreshes it.
 * finalizeClosed and expireOverdue key on that number, as do every GONE gate (capture,
 * setBidOverride, clearBidOverride, restore, rearm). On a portal that extends without a declared
 * ceiling, the posted close passes while the auction is still running: the request flips to
 * 'closed', leaves the operator worklist, and re-pricing it throws GONE - at exactly the moment
 * re-pricing is the only lever left. One observed GoComet auction extended 22 times and closed
 * nearly two hours past its posted time.
 *
 * The SAME write-once snapshot is the recorded root cause of two SuperProcure symptoms (the
 * arm-into-a-dead-auction defect, and reading a stale remaining-quantity that cost 17 refusals
 * across 4 loads). This change fixes the pricing-layer half only, and it must not move a single
 * SuperProcure record onto a different path - hence section G.
 *
 * WHAT THIS PINS:
 *   A. the capability predicate: a provisional close is declared (soft close + a ceiling declared
 *      as "none exists"), never inferred from a platform name. SuperProcure declares neither.
 *   B. refreshLiveClose's guards - forward-only, bounded by ONE declared extension step, no
 *      placeholder, no non-finite value, no terminal record, and refusal when no step is declared.
 *   C. the defect itself: a record past its SNAPSHOT close whose live close has moved is NOT
 *      filed closed, stays on the worklist, and its desk page still serves.
 *   D. it stays re-priceable - capture / setBidOverride / rearm do not throw GONE while live.
 *   E. it is NOT immortal: once the refreshed close passes with no further extension, it IS
 *      filed closed / expired, and re-arming it throws GONE again.
 *   F. an absurd far-future close (the year-2100 placeholder shape) is refused, and refusing it
 *      does not make the record immortal either.
 *   G. SuperProcure and untagged records take BYTE-IDENTICAL paths: set-equality of the resulting
 *      status maps against the pre-fix predicate, over a corpus spanning every sweepable status
 *      and every close shape, plus the structural claim that only one call site writes the field.
 *   H. the seam: the refresh rides adapter -> discovery -> pricing and nothing else.
 *   I. the desk page, over real HTTP: it still serves the cost form past a superseded close, and
 *      both surfaces the open page reads (the rendered countdown and the 4s /state poll) carry the
 *      live close. SuperProcure's page is byte-identical.
 *   J. the SHIPPED page script, executed: the form stays usable past a superseded close, LOCKS on
 *      the close it was actually given, stays locked while that close does not move, and reopens
 *      only on a strictly later one. The lock-still-holds checks are the ones that matter most - a
 *      fix that made loads immortal would be worse than the defect.
 *
 *   node scripts/test-live-close-refresh.js
 */
// server.js is the composition root and boots on require; pin it to the in-memory backing so this
// file never touches the checkout's data/ dir (the convention every server-requiring test follows).
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createStore } = require('../src/store');
const {
  PriceRequestStore, COLLECTION, effectiveCloseAt, MAX_PLAUSIBLE_DEADLINE_MS,
} = require('../src/pricing/priceRequests');
const {
  closeIsProvisional, declaredExtensionIncrementMs, MAX_HONOURED_EXTENSION_MS,
} = require('../src/platform/adapter');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { MockSuperProcureAdapter } = require('../src/platform/mockAdapter');
const { DiscoveryPoller } = require('../src/discovery/discovery');
const { Notifier } = require('../src/notify/notifier');
const { app, store: serverStore, pricingClosed } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// Every check below must run. The runner grades by EXIT CODE, so a file that exits 0 having
// asserted nothing is a silent green run; the sentinel at the bottom pins the count.
const EXPECTED_CHECKS = 49;

const STEP_MS = 300_000; // GoComet's declared per-round extension increment (299s, rounded up)
const MARGINS = [10], MIN = 5;

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const validToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' })}.sig`;

const BTN_LABEL = 'SUBMIT-LABEL'; // stands in for whatever copy the button ships with

function httpGet(base, p) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

const dataCloses = (html) => Number((html.match(/id="cd"[^>]*data-closes="(\d+)"/) || [])[1]);

/**
 * Run the countdown/lock script the BROWSER receives, on a virtual clock.
 *
 * Deliberately the shipped bytes, not the source: this page's JavaScript is assembled in template
 * literals and has already shipped broken once, so reading the source is the one check that cannot
 * catch what the browser gets. Everything the script touches is passed in as a parameter, which
 * shadows the global of the same name inside the function body - including Date, so `now()` reads
 * the virtual clock rather than the wall.
 */
function runPageScript(html, { startNow, state }) {
  const blocks = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) blocks.push(m[1]);
  const src = blocks.filter((b) => /function tick\(\)/.test(b)).pop();
  assert.ok(src, 'the rendered page carries the countdown script');

  let vnow = startNow;
  const timers = [];
  const el = (attrs) => ({
    _attrs: attrs || {}, className: '', textContent: '', innerHTML: '', disabled: false,
    style: {}, classList: { add() {}, remove() {} },
    getAttribute(k) { return this._attrs[k] != null ? String(this._attrs[k]) : null; },
    querySelector() { return null; }, appendChild() {},
  });
  const cd = el({ 'data-closes': dataCloses(html), 'data-deadline': Number((html.match(/data-deadline="(\d+)"/) || [])[1]) || 0 });
  const input = el();
  const btn = el(); btn.textContent = BTN_LABEL;
  const mainForm = el(); mainForm.querySelector = (sel) => (sel === 'button' ? btn : null);
  const cw = el();
  const byId = { cd, cost: input, mainForm, closewarn: cw };

  const document = {
    getElementById: (id) => (byId[id] || null),
    querySelector: () => null,
    createElement: () => el(),
    addEventListener() {},
  };
  const location = { pathname: '/price/I1', reload() {} };
  const fetchStub = () => Promise.resolve({ ok: true, json: () => Promise.resolve(state(vnow)) });
  const setTimeoutStub = (fn, ms) => { timers.push({ at: vnow + (Number(ms) || 0), fn }); };
  function DateStub(...a) { return new Date(...a); }
  DateStub.now = () => vnow;

  // eslint-disable-next-line no-new-func
  new Function('document', 'location', 'fetch', 'setTimeout', 'Date', src)(
    document, location, fetchStub, setTimeoutStub, DateStub,
  );

  return {
    cd,
    input,
    btn,
    async advance(ms) {
      const until = vnow + ms;
      // Drain microtasks between every firing so the poller's promise chain settles before the
      // next timer runs - the whole point is the ORDER a real page sees.
      for (let guard = 0; guard < 100_000; guard++) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > until) break;
        const t = timers.shift();
        vnow = t.at;
        t.fn();
        for (let i = 0; i < 8; i++) await Promise.resolve();
      }
      vnow = until;
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
  };
}

const newStore = () => createStore({ backend: 'memory' });
const newRequests = (store) => new PriceRequestStore({ store, marginsPct: MARGINS, minMarginPct: MIN });

/** Seed one request directly, for precise control over status / close shape / portal tag. */
function seed(store, id, { status = 'armed', closesAt, liveClosesAt, platformKey = 'gc', price = null, softClose = true } = {}) {
  const load = {
    companyName: 'Waaree Energies', lane: { origin: 'A', destination: 'B' }, units: 1,
    softClose, closeModelKnown: true, closesAt,
  };
  if (liveClosesAt != null) load.liveClosesAt = liveClosesAt;
  return store.putDoc(COLLECTION, id, {
    id, loadId: id, status, platformKey, load,
    marginsPct: MARGINS, minMarginPct: MIN, marginSource: 'default', marginOverride: null,
    deadlineAt: closesAt != null ? closesAt - 60_000 : null,
    price, capturedAt: price ? Date.now() : null, createdAt: Date.now() - 3_600_000, notified: true,
  });
}

(async () => {
  const now = Date.now();

  // =========================== A. the capability, never a platform name =======================
  // The behaviour is keyed on a DECLARED fact: this portal's close can move forward again and
  // nothing bounds how many times. GoComet declares closeModel 'soft' with extensionCeiling null
  // ("no cap exists"). SuperProcure's adapters declare closeModel 'unknown' and no ceiling key at
  // all, so they are excluded structurally rather than by an exemption anyone could remove.
  {
    const gcCaps = new GoCometAdapter({ token: validToken(), fetchImpl: async () => { throw new Error('no network'); } }).capabilities();
    const spCaps = new RealSuperProcureAdapter({ token: 'x' }).capabilities();
    const mockCaps = new MockSuperProcureAdapter().capabilities();

    ok(closeIsProvisional(gcCaps) === true, 'A: a soft close with a declared "no ceiling" is provisional');
    ok(closeIsProvisional(spCaps) === false, 'A: the real SuperProcure adapter declares no provisional close');
    ok(closeIsProvisional(mockCaps) === false, 'A: the simulator declares no provisional close');
    ok(closeIsProvisional({ closeModel: 'soft' }) === false,
      'A: soft with an ABSENT ceiling key is UNKNOWN, not "no ceiling" - not provisional');
    ok(declaredExtensionIncrementMs(gcCaps) === STEP_MS, 'A: the extension increment is read off the declaration');
    ok(declaredExtensionIncrementMs(spCaps) === null, 'A: SuperProcure declares no extension increment');

    // ONE SOURCE. The declared number is the adapter's own accessor, not a constant beside it, so a
    // portal whose increment is reconstructed from live observation cannot end up publishing one
    // value here and answering another on the state seam.
    const gcAdapter = new GoCometAdapter({ token: validToken(), fetchImpl: async () => { throw new Error('no network'); } });
    ok(gcAdapter.capabilities().extensionIncrementMs === gcAdapter.extensionIncrementMs(),
      'A: the declared increment IS what the adapter answers from its own accessor');

    // ...and because that accessor can GROW as a portal is observed, the declaration cannot be
    // trusted as a bound unclamped: an operator-seeded or learned value is adapter-owned, and this
    // is the one wall between a real extension and a corrupt close.
    ok(declaredExtensionIncrementMs({ extensionIncrementMs: 6 * 3_600_000 }) === MAX_HONOURED_EXTENSION_MS,
      'A: a declared increment wider than one honoured extension is CLAMPED, not taken at face value');
  }

  // =========================== B. refreshLiveClose guards =====================================
  {
    const store = newStore(); const requests = newRequests(store);
    const close = now + 60_000;

    await seed(store, 'B1', { closesAt: close });
    await requests.refreshLiveClose('B1', close + 120_000, { extensionStepMs: STEP_MS, nowMs: now });
    ok((await requests.getByToken('B1')).load.liveClosesAt === close + 120_000,
      'B: a forward move inside one declared step is accepted');

    await seed(store, 'B2', { closesAt: close });
    await requests.refreshLiveClose('B2', close - 30_000, { extensionStepMs: STEP_MS, nowMs: now });
    ok((await requests.getByToken('B2')).load.liveClosesAt === undefined,
      'B: a BACKWARD move is refused - pulling a close earlier could retire a live auction');

    await seed(store, 'B3', { closesAt: close });
    await requests.refreshLiveClose('B3', now + MAX_PLAUSIBLE_DEADLINE_MS + 86_400_000, { extensionStepMs: STEP_MS, nowMs: now });
    ok((await requests.getByToken('B3')).load.liveClosesAt === undefined,
      'B: a year-2100-shaped close parses fine and is refused anyway');

    await seed(store, 'B4', { closesAt: close });
    await requests.refreshLiveClose('B4', close + STEP_MS + 60_000, { extensionStepMs: STEP_MS, nowMs: now });
    ok((await requests.getByToken('B4')).load.liveClosesAt === undefined,
      'B: a jump larger than ONE declared extension step is refused');

    await seed(store, 'B5', { closesAt: close });
    await requests.refreshLiveClose('B5', Number.NaN, { extensionStepMs: STEP_MS, nowMs: now });
    await requests.refreshLiveClose('B5', null, { extensionStepMs: STEP_MS, nowMs: now });
    ok((await requests.getByToken('B5')).load.liveClosesAt === undefined,
      'B: a non-finite live close is refused');

    await seed(store, 'B6', { status: 'closed', closesAt: close });
    await requests.refreshLiveClose('B6', close + 120_000, { extensionStepMs: STEP_MS, nowMs: now });
    ok((await requests.getByToken('B6')).load.liveClosesAt === undefined,
      'B: a terminal record is never moved - a retired auction cannot re-open');

    await seed(store, 'B7', { closesAt: close });
    await requests.refreshLiveClose('B7', close + 120_000, { nowMs: now });
    ok((await requests.getByToken('B7')).load.liveClosesAt === undefined,
      'B: with no declared extension increment there is nothing to bound the move - refused');
  }

  // =========================== C. the defect ==================================================
  {
    const store = newStore(); const requests = newRequests(store);
    const posted = now - 30_000;                 // the posted close has already passed
    const live = now + 240_000;                  // ...but the platform is still running the auction
    await seed(store, 'C1', { status: 'armed', closesAt: posted, liveClosesAt: live,
      price: { cost: 10_000, marginsPct: MARGINS, minMarginPct: MIN } });

    const closed = await requests.finalizeClosed(now);
    const r = await requests.getByToken('C1');
    ok(closed === 0 && r.status === 'armed',
      'C: a load whose live close has moved past its snapshot close is NOT filed closed');
    ok((await requests.listAll()).some((x) => x.id === 'C1' && x.status === 'armed'),
      'C: it is still on the operator worklist');
    ok(pricingClosed(r, now) === false,
      'C: the desk page still serves it - the cost the operator types is not thrown away');
  }

  // =========================== D. still re-priceable ==========================================
  {
    const store = newStore(); const requests = newRequests(store);
    const posted = now - 30_000, live = now + 240_000;
    const price = { cost: 10_000, marginsPct: MARGINS, minMarginPct: MIN };

    await seed(store, 'D1', { status: 'armed', closesAt: posted, liveClosesAt: live, price });
    let threw = null;
    try { await requests.setBidOverride('D1', { marginsPct: [8], minMarginPct: 4, cost: 9_500 }); }
    catch (e) { threw = e.code || e.message; }
    ok(threw === null, `D: re-pricing a live extending load does not throw GONE (got ${threw})`);

    await seed(store, 'D2', { status: 'stopped', closesAt: posted, liveClosesAt: live, price });
    threw = null;
    try { await requests.rearm('D2'); } catch (e) { threw = e.code || e.message; }
    ok(threw === null, `D: re-arming a live extending load does not throw GONE (got ${threw})`);

    await seed(store, 'D3', { status: 'awaiting_price', closesAt: posted, liveClosesAt: live });
    threw = null;
    try { await requests.capture('D3', { cost: 10_000 }); } catch (e) { threw = e.code || e.message; }
    ok(threw === null, `D: a first cost is still accepted on a live extending load (got ${threw})`);
  }

  // =========================== E. NOT immortal ================================================
  // The assertion most likely to be missing. A refresh that can only ever defer the close would
  // trade one silent failure for a worse one: a worklist that never empties and a monitor that
  // never retires.
  {
    const store = newStore(); const requests = newRequests(store);
    const posted = now - 3_600_000;
    const lastLive = now - 1_000;   // the LAST extension we ever observed has now itself passed
    const price = { cost: 10_000, marginsPct: MARGINS, minMarginPct: MIN };

    await seed(store, 'E1', { status: 'armed', closesAt: posted, liveClosesAt: lastLive, price });
    await seed(store, 'E2', { status: 'awaiting_price', closesAt: posted, liveClosesAt: lastLive });
    await seed(store, 'E3', { status: 'stopped', closesAt: posted, liveClosesAt: lastLive, price });

    const closedCount = await requests.finalizeClosed(now);
    ok(closedCount === 3, `E: every ended extending record is filed closed (got ${closedCount})`);
    ok((await requests.getByToken('E1')).status === 'closed'
      && (await requests.getByToken('E3')).status === 'closed',
      'E: an armed and a stopped record both retire once the refreshed close has passed');

    // expireOverdue runs BEFORE finalizeClosed on a discovery tick, so prove it on its own store.
    const store2 = newStore(); const requests2 = newRequests(store2);
    await seed(store2, 'E4', { status: 'awaiting_price', closesAt: posted, liveClosesAt: lastLive });
    const expired = await requests2.expireOverdue(now);
    ok(expired.length === 1 && (await requests2.getByToken('E4')).status === 'skipped_no_price',
      'E: an un-priced record whose refreshed close has passed is still swept to skipped_no_price');

    let threw = null;
    const store3 = newStore(); const requests3 = newRequests(store3);
    await seed(store3, 'E5', { status: 'stopped', closesAt: posted, liveClosesAt: lastLive, price });
    try { await requests3.rearm('E5'); } catch (e) { threw = e.code; }
    ok(threw === 'GONE', `E: re-arming a genuinely ended auction throws GONE again (got ${threw})`);
  }

  // =========================== F. absurd close, refused and still mortal ======================
  {
    const store = newStore(); const requests = newRequests(store);
    const posted = now + 60_000;
    await seed(store, 'F1', { status: 'armed', closesAt: posted,
      price: { cost: 10_000, marginsPct: MARGINS, minMarginPct: MIN } });
    // The year-2100 shape: a perfectly valid Date, ~74 years out. NaN guards miss it entirely.
    await requests.refreshLiveClose('F1', Date.parse('2100-05-24T10:00:00Z'), { extensionStepMs: STEP_MS, nowMs: now });
    ok((await requests.getByToken('F1')).load.liveClosesAt === undefined,
      'F: an absurd far-future close is rejected, not honoured');
    const afterReal = await requests.finalizeClosed(posted + 1_000);
    ok(afterReal === 1 && (await requests.getByToken('F1')).status === 'closed',
      'F: refusing the absurd value leaves the record retiring on its own real close');

    // The SP-shaped placeholder SNAPSHOT path is untouched: a stored year-2100 closesAt is still
    // swept and normalised by finalizeClosed exactly as before.
    const store2 = newStore(); const requests2 = newRequests(store2);
    const placeholder = now + MAX_PLAUSIBLE_DEADLINE_MS + 86_400_000;
    await seed(store2, 'F2', { status: 'awaiting_price', closesAt: placeholder, platformKey: 'sp', softClose: false });
    await requests2.finalizeClosed(now);
    const f2 = await requests2.getByToken('F2');
    ok(f2.status === 'closed' && f2.load.closesAt === now,
      'F: the SuperProcure placeholder sweep + closesAt normalisation is unchanged');
  }

  // =========================== G. SuperProcure takes NO different path ========================
  // Set-equality over a corpus spanning every sweepable status crossed with every close shape,
  // graded against the PRE-FIX predicate transcribed below. This is the proof that the change is
  // SuperProcure-preserving: not "the SP tests still pass", but "for every SP-shaped record in
  // the space these methods branch on, the new code produces the same map the old code did".
  {
    // Transcribed from the code this change replaces: every gate read the write-once snapshot and
    // nothing else.
    const preFixCloseOf = (r) => (r.load && r.load.closesAt);

    const statuses = ['awaiting_price', 'armed', 'stopped', 'dismissed', 'skipped_no_price', 'closed'];
    const closeShapes = [
      ['past', now - 60_000],
      ['future', now + 600_000],
      ['placeholder', now + MAX_PLAUSIBLE_DEADLINE_MS + 86_400_000],
      ['absent', null],
    ];
    // Untagged records predate the platformKey field and are SuperProcure by construction.
    const portals = ['sp', undefined];

    const build = async (store) => {
      const ids = [];
      for (const st of statuses) {
        for (const [shape, closesAt] of closeShapes) {
          for (const p of portals) {
            const id = `G-${st}-${shape}-${p || 'untagged'}`;
            await seed(store, id, { status: st, closesAt, platformKey: p, softClose: false,
              price: { cost: 10_000, marginsPct: MARGINS, minMarginPct: MIN } });
            ids.push(id);
          }
        }
      }
      return ids;
    };

    const store = newStore(); const requests = newRequests(store);
    const ids = await build(store);

    const seeded = await requests.listAll();
    ok(ids.length === statuses.length * closeShapes.length * portals.length
      && seeded.length === ids.length
      && seeded.every((r) => effectiveCloseAt(r.load) === preFixCloseOf(r)),
      'G: the effective close of every SuperProcure/untagged record IS its snapshot close');

    // finalizeClosed
    const expectFinalize = {};
    for (const r of await requests.listAll()) {
      const c = preFixCloseOf(r);
      const sweepable = r.status === 'awaiting_price' || r.status === 'armed' || r.status === 'stopped';
      const placeholder = !!(c && c > now + MAX_PLAUSIBLE_DEADLINE_MS);
      expectFinalize[r.id] = (c && sweepable && (now >= c || placeholder)) ? 'closed' : r.status;
    }
    await requests.finalizeClosed(now);
    const gotFinalize = {};
    for (const r of await requests.listAll()) gotFinalize[r.id] = r.status;
    ok(JSON.stringify(gotFinalize) === JSON.stringify(expectFinalize),
      'G: finalizeClosed maps every SuperProcure/untagged record exactly as the pre-fix predicate did');

    // expireOverdue
    const store2 = newStore(); const requests2 = newRequests(store2);
    await build(store2);
    const expectExpire = {};
    for (const r of await requests2.listAll()) {
      const c = preFixCloseOf(r);
      const open = r.status === 'awaiting_price';
      const placeholder = !!(c && c > now + MAX_PLAUSIBLE_DEADLINE_MS);
      expectExpire[r.id] = (c && open && (now >= c || placeholder)) ? 'skipped_no_price' : r.status;
    }
    await requests2.expireOverdue(now);
    const gotExpire = {};
    for (const r of await requests2.listAll()) gotExpire[r.id] = r.status;
    ok(JSON.stringify(gotExpire) === JSON.stringify(expectExpire),
      'G: expireOverdue maps every SuperProcure/untagged record exactly as the pre-fix predicate did');

    // pruneEnded
    const store3 = newStore(); const requests3 = newRequests(store3);
    const ids3 = await build(store3);
    const retention = 7 * 86_400_000;
    const pruneAt = now + 30 * 86_400_000;
    const expectKept = [];
    for (const r of await requests3.listAll()) {
      const endedAt = preFixCloseOf(r) || r.createdAt;
      if (!(endedAt != null && pruneAt - endedAt > retention)) expectKept.push(r.id);
    }
    await requests3.pruneEnded(pruneAt, retention);
    const gotKept = (await requests3.listAll()).map((r) => r.id);
    ok(ids3.length > 0 && JSON.stringify(gotKept.slice().sort()) === JSON.stringify(expectKept.slice().sort()),
      'G: pruneEnded keeps/drops exactly the SuperProcure/untagged records the pre-fix predicate did');

    // The structural half of the claim: liveClosesAt has exactly ONE writer, and it is reached
    // from exactly one call site. A grep gate, in the shape test-store.js already uses, because a
    // set-equality proof over today's callers says nothing about a caller added tomorrow.
    const srcRoot = path.join(__dirname, '..', 'src');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      return d.isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
    });
    const files = walk(srcRoot);
    const writers = files.filter((f) => /liveClosesAt\s*:/.test(fs.readFileSync(f, 'utf8')));
    const callers = files.filter((f) => /\.refreshLiveClose\s*\(/.test(fs.readFileSync(f, 'utf8')));
    ok(writers.length === 1 && writers[0].endsWith(path.join('pricing', 'priceRequests.js')),
      `G: exactly one module writes liveClosesAt (got ${writers.map((f) => path.basename(f)).join(', ')})`);
    ok(callers.length === 1 && callers[0].endsWith(path.join('discovery', 'discovery.js')),
      `G: exactly one module calls refreshLiveClose (got ${callers.map((f) => path.basename(f)).join(', ')})`);
  }

  // =========================== H. the discovery seam ==========================================
  // The refresh rides the EXISTING adapter -> discovery -> priceRequests direction. Pricing never
  // reaches into the engine, and the engine is not touched at all.
  {
    const notifier = new Notifier({ mode: 'dashboard', baseUrl: 'http://t' });
    const cfg = { allowlist: { shippers: ['Waaree'] }, priceDeadlineLeadMs: 60_000 };
    const posted = now - 30_000;
    const extended = now + 200_000;

    const listing = (closesAt) => ([{
      id: 'H1', companyName: 'Waaree Energies', lane: { origin: 'A', destination: 'B' }, units: 1,
      status: 'open', closesAt, softClose: true, closeModelKnown: true,
    }]);

    const runTick = async (caps) => {
      const store = newStore(); const requests = newRequests(store);
      await seed(store, 'H1', { status: 'armed', closesAt: posted, platformKey: 'gc',
        price: { cost: 10_000, marginsPct: MARGINS, minMarginPct: MIN } });
      const adapter = { listAuctions: async () => listing(extended) };
      if (caps) adapter.capabilities = () => caps;
      const poller = new DiscoveryPoller({ adapter, requests, notifier, config: cfg, platformKey: 'gc' });
      await poller._tick();
      return requests.getByToken('H1');
    };

    const gcCaps = { closeModel: 'soft', extensionCeiling: null, extensionIncrementMs: STEP_MS };
    const afterGc = await runTick(gcCaps);
    ok(afterGc.load.liveClosesAt === extended && afterGc.status === 'armed',
      'H: a provisional-close poller refreshes the record from the live listing and does not retire it');

    const afterSp = await runTick({ closeModel: 'unknown', biddingEnabled: true });
    ok(afterSp.load.liveClosesAt === undefined && afterSp.status === 'closed',
      'H: a SuperProcure-shaped poller never writes the field, and the record retires exactly as today');

    const afterNoCaps = await runTick(null);
    ok(afterNoCaps.load.liveClosesAt === undefined,
      'H: an adapter with no capabilities() at all is treated as declaring nothing');

    // A listing that has NOT moved must not rewrite the record every 30s.
    const store = newStore(); const requests = newRequests(store);
    await seed(store, 'H1', { status: 'armed', closesAt: now + 600_000, platformKey: 'gc',
      price: { cost: 10_000, marginsPct: MARGINS, minMarginPct: MIN } });
    const poller = new DiscoveryPoller({
      adapter: { capabilities: () => gcCaps, listAuctions: async () => listing(now + 600_000) },
      requests, notifier, config: cfg, platformKey: 'gc',
    });
    await poller._tick();
    ok((await requests.getByToken('H1')).load.liveClosesAt === undefined,
      'H: an unchanged close writes nothing - the field records a MOVE, not every poll');
  }

  // =========================== I. the desk page, served over real HTTP ========================
  // The page is the ONLY way a human can put a cost on a load, so a server that keeps the record
  // alive while the page renders itself dead has fixed nothing. Driven over HTTP rather than by
  // calling the renderer, because the 410 branch lives in the route, not in the renderer.
  {
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const posted = now - 30_000, live = Date.now() + 240_000;
      await seed(serverStore, 'I1', { status: 'awaiting_price', closesAt: posted, liveClosesAt: live, platformKey: 'gc' });
      const page = await httpGet(base, '/price/I1');
      ok(page.status === 200 && /id="cost"/.test(page.body),
        `I: a load live past its posted close still serves the cost form (got ${page.status})`);
      ok(dataCloses(page.body) === live,
        `I: the countdown the page renders is the LIVE close, not the superseded snapshot (got ${dataCloses(page.body)})`);
      const state = JSON.parse((await httpGet(base, '/price/I1/state')).body);
      ok(state.closesAt === live,
        `I: the 4s poller is served the live close too, so a reload recovers (got ${state.closesAt})`);

      // The SuperProcure half of the same page: no liveClosesAt is ever written onto these records,
      // so both surfaces must still carry the snapshot byte for byte.
      const spClose = Date.now() + 600_000;
      await seed(serverStore, 'I2', { status: 'awaiting_price', closesAt: spClose, platformKey: 'sp', softClose: false });
      const spPage = await httpGet(base, '/price/I2');
      const spState = JSON.parse((await httpGet(base, '/price/I2/state')).body);
      ok(dataCloses(spPage.body) === spClose,
        'I: a SuperProcure page renders its snapshot close exactly as before');
      ok(spState.closesAt === spClose,
        'I: a SuperProcure /state serves its snapshot close exactly as before');

      // =========================== J. the shipped page script ================================
      // Run the countdown/lock script the browser actually receives, against a virtual clock and a
      // /state stream we control. The three properties that matter, in the order they matter:
      // it stays usable past a superseded close, it LOCKS on the real one, and a lock only ever
      // lifts because the server published a later close.
      {
        // The auction is live past its posted close, then genuinely ends at `live`.
        let served = live;
        const run = runPageScript(page.body, {
          startNow: Date.now(),
          state: (atMs) => ({ status: 'awaiting_price', serverTime: atMs, closesAt: served }),
        });

        await run.advance(5_000);
        ok(run.input.disabled === false && run.btn.textContent === BTN_LABEL,
          'J: the form stays usable while the auction is genuinely live past its posted close');

        await run.advance(live - Date.now() + 2_000);
        ok(run.input.disabled === true && run.btn.textContent === 'Auction closed',
          'J: it locks once the close it was actually given passes');

        // The lock is NOT weakened: a /state that keeps repeating the same close leaves it locked,
        // however long the page stays open.
        await run.advance(120_000);
        ok(run.input.disabled === true && run.btn.textContent === 'Auction closed',
          'J: a locked form stays locked while the served close does not move');

        // ...and lifts only on a strictly later close - the extension this whole change exists for.
        served = live + 300_000;
        await run.advance(10_000);
        ok(run.input.disabled === false && run.btn.textContent === BTN_LABEL,
          'J: a strictly LATER close reopens the form the desk has to type into');
        ok(/to close$/.test(run.cd.textContent),
          `J: the countdown resumes against the new close (got ${JSON.stringify(run.cd.textContent)})`);

        // A close that moves BACKWARD is not an extension; the server never publishes one, and the
        // page must not act on one either.
        served = live + 300_000;
        await run.advance(300_000 + 2_000);
        served = live + 60_000;
        await run.advance(10_000);
        ok(run.input.disabled === true,
          'J: an EARLIER close never reopens a locked form');
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  // ---- completion sentinel ----
  assert.strictEqual(fail, 0, `${fail} live-close-refresh checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - the file exited early or a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
