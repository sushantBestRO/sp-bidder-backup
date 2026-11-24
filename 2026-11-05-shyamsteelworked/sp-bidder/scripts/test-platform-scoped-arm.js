'use strict';
/**
 * A REQUEST NEVER ARMS A PORTAL IT DOES NOT BELONG TO.
 *
 * stackForRequest resolved on account id alone and fell through to `stacks[0]`, which is always a
 * SuperProcure stack. So whenever the GoComet stack was absent - an unset or blank GC_TOKEN across
 * the monthly OTP rotation, GC_ENABLE not '1' on a restart, or attachGoCometStack's catch - a
 * persisted GoComet request resolved onto the SuperProcure engine: a real ladder built from the
 * GoComet cost, a monitor keyed on a GoComet enquiry key, and that key written into SuperProcure's
 * OWN durable intents file, where the SP supervisor re-arms it on every restart until close. The
 * record reads 'armed' on the money surface while nothing bids it on either portal.
 *
 * NO BID REACHES SUPERPROCURE ONLY BY ACCIDENT, and that is why this file exists rather than a note.
 * GoComet enquiry keys are alphanumeric and SuperProcure load ids are 8-digit numerics, so the
 * SP adapter answers {ok:false} and the tick returns before placeBid. Nothing enforces that id-space
 * split. It is not a guard and must never be relied on as one.
 *
 * The scenario boots the real composition root with GC_ENABLE on and no token, which is exactly the
 * state the rotation window produces, then drives the two doors onto the arm path:
 *   POST /api/auctions/:loadId/rearm  - the console's one-click Re-arm, which carries no scope
 *                                       backstop of its own and is offered on precisely the
 *                                       'stopped'-with-cost row holdUnbiddable leaves behind.
 *   POST /price/:token                - the desk's own cost submit. Its allowlist backstop refuses
 *                                       a soft-close load only while hardCloseOnly is on, so this
 *                                       runs with it off: the incidental protection, removed.
 *
 * Re-execs itself once so the child owns its env before server.js loads.
 */

const fs = require('fs'); // allowed: test harness (temp dir + subprocess), not app state
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const EXPECTED_CHECKS = 18;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

function post(base, p, body) {
  const http = require('http');
  const u = new URL(base + p);
  const payload = JSON.stringify(body || {});
  return new Promise((resolve, reject) => {
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      // Origin satisfies the CSRF guard on /api routes; without it every POST is refused before
      // the handler runs and this file would assert nothing about the arm path.
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), origin: u.origin },
    }, (res) => {
      let buf = ''; res.on('data', (d) => (buf += d));
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, json, body: buf }); });
    });
    r.on('error', reject); r.write(payload); r.end();
  });
}

/** A GoComet load as discovery stamps it: soft close, verified, its own portal key. */
function gcLoad(id, closesAt) {
  return {
    id, companyName: 'Waaree Energies', lane: { origin: 'Surat', destination: 'Pune' },
    units: 1, closesAt, softClose: true, closeModelKnown: true,
  };
}

async function scenario() {
  const srv = require('../src/web/server');
  await srv.boot();
  const { COLLECTION, platformOf } = require('../src/pricing/priceRequests');

  ok(srv.gocometStack == null,
    'setup: GC_ENABLE=1 with no GC_TOKEN leaves the GoComet stack unbuilt - the rotation-window state');
  ok(srv.stacks.length >= 1 && srv.stacks.every((s) => platformOf(s) === 'sp'),
    'setup: every running stack is a SuperProcure one, so stacks[0] is what the old fallback returned');

  // Soft-close loads admitted, which is what removes the capture path's incidental protection.
  srv.applyConfigValues(await srv.configStore.save({
    allowlist: { shippers: ['Waaree'], lanes: [], hardCloseOnly: false },
  }));

  const now = Date.now();
  const closesAt = now + 45 * 60_000;

  // (a) the parked row: priced, cost kept, awaiting the portal - what holdUnbiddable leaves and
  //     what the console offers Re-arm on.
  await srv.store.putDoc(COLLECTION, 'gcstoppedtoken', {
    id: 'gcstoppedtoken', loadId: 'YT2ZWR', status: 'stopped', heldReason: 'platform_bidding_disabled',
    platformKey: 'gocomet', account: { accountId: 'gocomet', label: 'GoComet' },
    load: gcLoad('YT2ZWR', closesAt),
    marginsPct: [12, 8, 6], minMarginPct: 6, marginSource: 'default', marginOverride: null,
    price: { cost: 41_500, marginsPct: [12, 8, 6], minMarginPct: 6 },
    capturedAt: now - 60_000, stoppedAt: now - 60_000, createdAt: now - 120_000, notified: true,
  });
  // (b) an unpriced row for the desk's own submit path.
  await srv.store.putDoc(COLLECTION, 'gcawaitingtoken', {
    id: 'gcawaitingtoken', loadId: 'QP8KLM', status: 'awaiting_price',
    platformKey: 'gocomet', account: { accountId: 'gocomet', label: 'GoComet' },
    load: gcLoad('QP8KLM', closesAt),
    marginsPct: [12, 8, 6], minMarginPct: 6, marginSource: 'default', marginOverride: null,
    deadlineAt: closesAt - 60_000, createdAt: now, notified: true, notifiedAt: now,
  });

  // ---- resolution ------------------------------------------------------------------------------
  const parked = await srv.requests.getByToken('gcstoppedtoken');
  const resolved = srv.stackForRequest(parked);
  ok(resolved === undefined,
    `a GoComet request with no GoComet stack resolves to NOTHING (got ${resolved ? platformOf(resolved) : 'undefined'})`);
  ok(srv.stackForRequest({}) === srv.stacks[0],
    'an untagged (pre-GoComet) request still resolves to stacks[0] - SuperProcure routing is unchanged');
  ok(srv.stackForRequest({ account: { accountId: 'primary' } }) === srv.stacks[0],
    'and so does a SuperProcure request naming its own account');

  const server = srv.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // ---- the Re-arm button ----------------------------------------------------------------------
    const rearm = await post(base, '/api/auctions/YT2ZWR/rearm', {});
    ok(rearm.status === 409,
      `Re-arm on a portal that is not running is refused, not served (got ${rearm.status})`);
    ok(!!rearm.json && /gocomet/.test(rearm.json.error || ''),
      `...and the refusal names the portal that is missing (got ${rearm.json && rearm.json.error})`);
    const afterRearm = await srv.requests.getByToken('gcstoppedtoken');
    ok(afterRearm.status === 'stopped',
      `the record stays parked rather than flipping to 'armed' (got '${afterRearm.status}')`);
    ok(afterRearm.price && afterRearm.price.cost === 41_500,
      'the desk cost survives the refusal, so the button still works the day the portal returns');

    // ---- the desk's own submit -------------------------------------------------------------------
    const submit = await post(base, '/price/gcawaitingtoken', { cost: 39_000 });
    ok(submit.status === 409,
      `the desk's cost on a portal that is not running is a 409, not a 500 (got ${submit.status})`);
    const afterSubmit = await srv.requests.getByToken('gcawaitingtoken');
    ok(afterSubmit.status === 'stopped',
      `...the row is PARKED, never reopened to 'awaiting_price' (got '${afterSubmit.status}')`);
    ok(afterSubmit.price && afterSubmit.price.cost === 39_000,
      '...the number the desk typed is KEPT (reopen would have nulled it and filed the row as their silence)');
    ok(afterSubmit.heldReason === 'platform_stack_unavailable',
      `...and the record says WHY, distinctly from a shut write gate (got '${afterSubmit.heldReason}')`);
  } finally {
    server.close();
  }

  // ---- nothing landed on SuperProcure ------------------------------------------------------------
  for (const s of srv.stacks) {
    const mons = s.engine.snapshot().map((m) => String(m.auctionId));
    ok(!mons.includes('YT2ZWR') && !mons.includes('QP8KLM'),
      `no SuperProcure engine holds a monitor for a GoComet enquiry key (got ${JSON.stringify(mons)})`);
    ok(!s.scheduler.get('YT2ZWR') && !s.scheduler.get('QP8KLM'),
      'no GoComet key reached a SuperProcure durable intent (the contamination that survived restarts)');
  }
  // The intent file is the artefact that outlives the process, so assert it on disk too.
  const intentFiles = fs.readdirSync(process.env.SP_DATA_DIR).filter((f) => /intents/.test(f));
  const contaminated = intentFiles.filter((f) => /YT2ZWR|QP8KLM/.test(fs.readFileSync(path.join(process.env.SP_DATA_DIR, f), 'utf8')));
  ok(contaminated.length === 0,
    `no GoComet key is written into a SuperProcure intents file on disk (found in ${JSON.stringify(contaminated)})`);

  // ---- and the page says the same thing the arm does ---------------------------------------------
  const facts = srv.portalFactsFor(await srv.requests.getByToken('gcstoppedtoken'));
  ok(facts.biddingEnabled === false,
    'the price page reports the load as not-biddable, rather than inheriting an empty capabilities object');
  const wont = srv.loadWillNotBid(await srv.requests.getByToken('gcstoppedtoken'), facts);
  ok(!!wont && wont.keepsCost === true,
    'and it is the cost-KEEPING refusal, so the desk is asked for a number that is still worth having');

  for (const s of srv.stacks) { try { if (s.discovery) s.discovery.stop(); } catch (_) {} }
  try { srv.stacks.forEach((s) => s.engine.snapshot().forEach((m) => s.engine.stop(m.auctionId))); } catch (_) {}
}

if (process.argv[2] === 'child') {
  scenario()
    .then(() => { console.log(`SCENARIO_RESULT ${pass} ${fail}`); process.exit(fail ? 1 : 0); })
    .catch((e) => {
      console.error('scenario crashed:', (e && e.stack) || e);
      console.log(`SCENARIO_RESULT ${pass} ${fail + 1}`);
      process.exit(1);
    });
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-arm-'));
  // Mock mode: the operator login gate is off, so the two routes are reachable without a session,
  // and the SuperProcure stack carries no platformKey - the untagged-legacy case, under test rather
  // than bypassed. GC_TOKEN is deliberately ABSENT; GC_ENABLE is on.
  const env = Object.assign({}, process.env, {
    PLATFORM: 'mock', STORE_BACKEND: 'memory', PORT: '0', SP_DATA_DIR: dir,
    SP_WHATSAPP_ENABLED: '0', GC_ENABLE: '1',
  });
  delete env.GC_TOKEN; delete env.SP_DEMO_SEED;
  delete env.SP_ADMIN_PASS_HASH; delete env.SP_SESSION_SECRET;

  const r = spawnSync(process.execPath, [__filename, 'child'], { env, encoding: 'utf8', timeout: 60_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = out.match(/SCENARIO_RESULT (\d+) (\d+)/);
  for (const line of out.split('\n')) if (/FAIL -|scenario crashed|SCENARIO_RESULT/.test(line)) console.log(line);
  if (!m) {
    fail += 1;
    console.error(`  FAIL - the child produced no result line (exit ${r.status}) - it died before asserting`);
    console.error(out.split('\n').slice(-20).join('\n'));
  } else {
    pass += Number(m[1]); fail += Number(m[2]);
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

  // The runner grades by EXIT CODE, so a child that returned early would otherwise be a silent
  // green zero-assertion run.
  assert.strictEqual(fail, 0, `${fail} platform-scoped arm checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - the child exited early or a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
}
