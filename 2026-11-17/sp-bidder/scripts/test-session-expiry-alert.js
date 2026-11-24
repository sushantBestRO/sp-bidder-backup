'use strict';
/**
 * Session-expiry alert cadence + routing (owner ask, 2026-09-10, observed live on the Rallis
 * white-label session). The rationale for each property lives at the top of src/notify/tokenExpiry.js;
 * this file is the pin.
 *
 * PART 1  the rung ladder: single 30m rung, 2h/15m dropped
 * PART 2  the disconnect alert: desk-only, distinct copy and dedupe namespace from the warning
 * PART 3  routing, through the REAL Notifier - who is reached, and who is deliberately not
 * PART 4  copy discipline: two audiences, two strings; no internal label in the customer's group
 * PART 5  the paired all-clear, on the accepted-write rail
 *
 * Offline and deterministic - no network, no live SuperProcure.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { checkTokenExpiry, SHORT_WARN_MS } = require('../src/notify/tokenExpiry');
const { Notifier } = require('../src/notify/notifier');
const { templateFor, renderMessage } = require('../src/notify/waTemplates');
const { raiseAuthRestored } = require('../src/notify/authAlert');
const { deskCustomerFor } = require('../src/auth/accounts');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const MINUTE = 60000, HOUR = 3600000;
const RALLIS_LIFE_MS = Math.round(8.16 * HOUR);
const OPS = '919000000001';
const RALLIS_GROUP = '911234567890-1234567890@g.us';
const HAVELLS_GROUP = '919876543210-9876543210@g.us';
const ALL_LOADS_GROUP = '915555500000-5555500000@g.us';
const RALLIS_BRANCH_GROUP = '914444400000-4444400000@g.us';

function fakeNotifier() {
  const calls = [];
  return { calls, alert: async (kind, payload, opts = {}) => { calls.push({ kind, payload, opts }); } };
}

// The real Notifier on a captured wire. `logs` collects what it emitted, which is how the
// zero-recipient warning is asserted - that warning IS the observability fix, so it has to be
// checked as behaviour and not merely read in the source.
function realNotifier(recipients) {
  const sent = [];
  const logs = [];
  const wa = {
    enabled: () => true,
    sendText: async (phone, message, opts) => { sent.push({ phone, message, opts }); return { ok: true }; },
  };
  const notifier = new Notifier({
    mode: 'whatsapp', wa, log: (m) => logs.push(String(m)), recipientsProvider: async () => recipients,
  });
  return { notifier, sent, logs };
}

// The recipient table as BRL actually configures it: one unscoped ops line on the admin channel,
// one shipper-scoped group per customer, plus the two shapes the routing must refuse or reach.
function recipientTable() {
  return [
    { name: 'Ops', phone: OPS, alerts: ['error'] },
    { name: 'Rallis Bids', phone: RALLIS_GROUP, alerts: ['desk_notice'], scope: { shippers: ['rallis'] } },
    { name: 'Havells Bids', phone: HAVELLS_GROUP, alerts: ['desk_notice'], scope: { shippers: ['havells'] } },
  ];
}

(async () => {
  // ================= PART 1: the rung ladder =================
  {
    ok(SHORT_WARN_MS.length === 1 && SHORT_WARN_MS[0] === 30 * MINUTE,
      'the short-lived ladder carries exactly one rung, at 30 minutes');

    const now = Date.now();

    // 2 hours out: nothing fires. This is the exact firing the owner asked to drop.
    const n2h = fakeNotifier();
    await checkTokenExpiry({ tokenExp: now + 2 * HOUR, notifier: n2h, now, accountLabel: 'rallis', tokenLifetimeMs: RALLIS_LIFE_MS });
    ok(n2h.calls.length === 0, '2 hours out is silent - the 2h rung is gone');

    // 30 minutes out: crosses the one remaining rung, fires exactly once per channel.
    const n30 = fakeNotifier();
    await checkTokenExpiry({ tokenExp: now + 30 * MINUTE, notifier: n30, now, accountLabel: 'rallis', tokenLifetimeMs: RALLIS_LIFE_MS, deskCustomer: 'Rallis' });
    const err30 = n30.calls.filter((c) => c.kind === 'error');
    ok(err30.length === 1, '30 minutes out fires exactly one admin warning');
    ok(/_30m$/.test(err30[0].opts.dedupeKey), 'keyed to the 30m rung');

    // 15 minutes out: STILL the same 30m rung, not a second, more-urgent alert - exactly one
    // pre-expiry warning total is the owner's ask, not one warning per rung crossed.
    const n15 = fakeNotifier();
    await checkTokenExpiry({ tokenExp: now + 15 * MINUTE, notifier: n15, now, accountLabel: 'rallis', tokenLifetimeMs: RALLIS_LIFE_MS, deskCustomer: 'Rallis' });
    const err15 = n15.calls.filter((c) => c.kind === 'error');
    ok(err15.length === 1 && /_30m$/.test(err15[0].opts.dedupeKey),
      '15 minutes out still fires the single 30m rung, never a distinct 15m alert');
  }

  // ================= PART 2: the disconnect alert =================
  {
    const now = Date.now();
    const n = fakeNotifier();
    await checkTokenExpiry({ tokenExp: now - HOUR, notifier: n, now, accountLabel: 'rallis', tokenLifetimeMs: RALLIS_LIFE_MS, deskCustomer: 'Rallis' });

    // THE ADMIN HALF IS NOT RAISED HERE. account_auth_expired owns it (realAdapter ->
    // raiseAuthDead), and raising a second 'error' from the clock put two admin WhatsApps on
    // every lapse - the duplication this change removes.
    ok(n.calls.filter((c) => c.kind === 'error').length === 0,
      'a lapsed session raises NO admin error from the clock - account_auth_expired owns that copy');

    const deskCalls = n.calls.filter((c) => c.kind === 'desk_notice');
    ok(deskCalls.length === 1, 'the disconnect raises exactly one desk_notice');
    ok(n.calls.length === 1, 'and nothing else - exactly one alert() call per lapsed-session check');

    const detail = deskCalls[0].payload.detail;
    ok(/^Bidding has stopped for Rallis/.test(detail), 'the desk copy leads with the fact, verbatim: "Bidding has stopped for Rallis"');
    ok(/disconnected/i.test(detail), 'and states the access is disconnected');
    ok(!/expires/i.test(detail), 'it does not reuse the pre-expiry "expires" wording - this is a distinct fact');
    ok(deskCalls[0].payload.shipper === 'Rallis', 'the desk_notice routes on the CUSTOMER, not the account label');
    ok(deskCalls[0].payload.accountWide === true, 'flagged accountWide, so scopeMatches judges it on shipper alone and fails closed on an empty scope');
    ok(deskCalls[0].payload.sessionAlert === 'disconnected', 'flagged for the disconnected template variant');
    ok(templateFor('desk_notice', deskCalls[0].payload) === 'session_disconnected',
      'and that flag resolves to the session_disconnected template');
    ok(/^token_expired_desk_rallis_\d+$/.test(deskCalls[0].opts.dedupeKey),
      'dedupe key is its own namespace (token_expired_desk_...), distinct from the warning (token_expiry_warn_...)');
  }

  // ================= PART 3: routing, through the real Notifier =================
  // Not a stub: scope-matching and group delivery are genuinely exercised. Every fail-closed
  // property below is a route that LOOKS safe through a stub and is not.
  {
    async function routeCheck(tokenExpOffsetMs, { recipients = recipientTable(), deskCustomer = 'Rallis' } = {}) {
      const { notifier, sent, logs } = realNotifier(recipients);
      const now = Date.now();
      await checkTokenExpiry({ tokenExp: now + tokenExpOffsetMs, notifier, now, accountLabel: 'rallis', tokenLifetimeMs: RALLIS_LIFE_MS, deskCustomer });
      return { sent, logs, to: (p) => sent.filter((s) => s.phone === p) };
    }

    // --- the 30-minute warning reaches both audiences ---
    const warn = await routeCheck(20 * MINUTE);
    ok(warn.to(OPS).length === 1, 'the 30m warning reaches the admin recipient');
    ok(/Bid Command alert/.test(warn.to(OPS)[0].message), 'admin copy renders the ops alert template');
    ok(warn.to(RALLIS_GROUP).length === 1, "the 30m warning ALSO reaches the account's own customer WhatsApp group");
    ok(/Session expiring soon/.test(warn.to(RALLIS_GROUP)[0].message), 'group copy renders the desk-facing template');
    ok(warn.to(HAVELLS_GROUP).length === 0, "a DIFFERENT customer's group never receives this account's session alert");

    // --- the disconnect: desk only, no second admin copy on the wire ---
    const down = await routeCheck(-HOUR);
    ok(down.to(OPS).length === 0, 'the disconnect sends the ops line nothing - the wire rail (account_auth_expired) carries the admin copy');
    ok(down.to(RALLIS_GROUP).length === 1, "the disconnect reaches the account's own customer WhatsApp group");
    ok(/Session disconnected/.test(down.to(RALLIS_GROUP)[0].message), 'group copy renders the disconnected template');

    // --- FAIL CLOSED 1: an unscoped / alertAll recipient is NOT a customer channel. Under the
    // general scope rule an empty scope matches EVERY load, so these would have received another
    // customer's outage - a fan-out dressed as a no-op.
    //
    // The customer's own group is deliberately ABSENT from this table. With it present the
    // group-precedence rule suppresses the individual/unscoped path whenever the group send
    // succeeds, which HIDES the fan-out behind a passing test; the exposure is real exactly when no
    // scoped group takes the message - a customer with no group yet, or a scope token that does not
    // match. That is the table below.
    const fanout = await routeCheck(-HOUR, {
      recipients: [
        { name: 'Ops', phone: OPS, alerts: ['error'] },
        { name: 'All Loads', phone: ALL_LOADS_GROUP, alerts: ['desk_notice'] },
        { name: 'Director', phone: '919000000009', alerts: ['desk_notice'], scope: { shippers: [] } },
      ],
    });
    ok(fanout.to(ALL_LOADS_GROUP).length === 0,
      'an UNSCOPED desk_notice group receives nothing - an account-wide notice fails closed on an empty scope');
    ok(fanout.to('919000000009').length === 0, 'and so does a recipient carrying an explicitly empty shipper scope');
    ok(fanout.sent.length === 0, 'with no group naming the customer, the notice reaches NOBODY rather than everybody');

    // ...and the named customer group is still reached when it exists alongside those recipients.
    const named = await routeCheck(-HOUR, {
      recipients: recipientTable().concat([{ name: 'All Loads', phone: ALL_LOADS_GROUP, alerts: ['desk_notice'] }]),
    });
    ok(named.to(RALLIS_GROUP).length === 1, 'the named customer group still gets it');
    ok(named.to(ALL_LOADS_GROUP).length === 0, 'and the all-loads group still does not');

    // --- FAIL CLOSED 2: no customer resolves for this account, so nothing is sent on the customer
    // channel at all. The account label is never used as a fallback scope key.
    const shared = await routeCheck(-HOUR, { deskCustomer: null });
    ok(shared.sent.length === 0, 'with no single customer mapped to the account, no desk notice is sent to anybody');

    // --- A BRANCH-SCOPED GROUP IS REACHABLE. scopeMatches ANDs every dimension a recipient sets,
    // and an account-wide fact carries no branch, so this group was structurally unmatchable.
    const branchy = await routeCheck(-HOUR, {
      recipients: recipientTable().concat([
        { name: 'Rallis Ankleshwar', phone: RALLIS_BRANCH_GROUP, alerts: ['desk_notice'],
          scope: { shippers: ['rallis'], branches: ['Ankleshwar (1350)'], origins: ['Ankleshwar'] } },
      ]),
    });
    ok(branchy.to(RALLIS_BRANCH_GROUP).length === 1,
      'a branch- and origin-narrowed group whose shipper names the customer STILL receives the account-wide notice');

    // --- THE ZERO-RECIPIENT WARNING. The recipient's scope token and the account's deskCustomer are
    // two independently maintained config surfaces; when they disagree the send reaches nobody, and
    // that miss has to be loud rather than a quiet return (price-page gate, bucket 3).
    const missed = await routeCheck(-HOUR, {
      recipients: [{ name: 'Ops', phone: OPS, alerts: ['error'] },
        { name: 'Rallis Bids', phone: RALLIS_GROUP, alerts: ['desk_notice'], scope: { shippers: ['tata-chemicals'] } }],
    });
    ok(missed.sent.length === 0, 'a scope token that does not name the customer matches nobody');
    ok(missed.logs.some((m) => /matched ZERO recipients/.test(m)),
      'and the notifier says so - a zero-recipient account-wide notice is logged, never a silent return');

    // The warning is NOT emitted on the ordinary kinds, which legitimately resolve to zero
    // recipients all day - burying this line under those would be the same as not having it.
    const quiet = realNotifier([]);
    await quiet.notifier.alert('lost', { auctionId: 'A-1', shipper: 'Rallis' }, { dedupeKey: 'k1' });
    ok(!quiet.logs.some((m) => /matched ZERO recipients/.test(m)),
      'an ordinary alert that matches nobody stays quiet - the warning is scoped to account-wide notices');
  }

  // ================= PART 4: copy discipline, two audiences =================
  // Owner complaints, 2026-09-10: message length, and internal wording reaching a customer group.
  {
    const now = Date.now();
    const n = fakeNotifier();
    await checkTokenExpiry({ tokenExp: now + 20 * MINUTE, notifier: n, now, accountLabel: 'sp-rallis-2', product: 'SuperProcure', tokenLifetimeMs: RALLIS_LIFE_MS, deskCustomer: 'Rallis' });
    const adminWarn = n.calls.find((c) => c.kind === 'error').payload.detail;
    const deskWarn = n.calls.find((c) => c.kind === 'desk_notice').payload.detail;

    ok(adminWarn !== deskWarn, 'the admin and desk copies are two different strings, not one sentence sent twice');
    ok(/sp-rallis-2/.test(adminWarn), 'the ADMIN copy keeps the account label - it is what disambiguates accounts on a multi-account box');
    ok(!/sp-rallis-2/.test(deskWarn), 'the CUSTOMER copy never carries the internal account label');
    ok(!/^Reconnect/.test(deskWarn), 'nor an instruction only BRL ops can carry out');
    ok(/^Bidding access for Rallis runs out in ~20m/.test(deskWarn), 'it names the customer and states the time left');
    ok(/Quote these loads on the portal/.test(deskWarn), 'and gives the desk the one thing the desk can do');
    ok(deskWarn.split('\n').length === 1, 'the desk detail is a single line, no paragraph');
    ok(!/\btoken\b|\bJWT\b|\bsession\b/i.test(deskWarn), 'no jargon on the customer copy - never token, JWT or session');

    const n2 = fakeNotifier();
    await checkTokenExpiry({ tokenExp: now - HOUR, notifier: n2, now, accountLabel: 'sp-rallis-2', tokenLifetimeMs: RALLIS_LIFE_MS, deskCustomer: 'Rallis' });
    const deskDown = n2.calls.find((c) => c.kind === 'desk_notice').payload.detail;
    ok(!/sp-rallis-2/.test(deskDown), 'the disconnect copy carries no internal account label either');
    ok(deskDown.split('\n').length === 1, 'the disconnect detail is a single line, no paragraph');

    // Two rendered lines each - one header, one sentence.
    for (const [label, payload] of [['expiring', n.calls.find((c) => c.kind === 'desk_notice').payload],
      ['disconnected', n2.calls.find((c) => c.kind === 'desk_notice').payload]]) {
      const body = renderMessage(templateFor('desk_notice', payload), payload);
      ok(String(body).split('\n').length === 2, `the ${label} group message renders as two lines`);
    }
  }

  // ================= PART 5: the paired all-clear =================
  // The disconnect notice makes a STANDING claim on a customer channel. Without a withdrawal that
  // desk hand-quotes indefinitely, and the desk and this system share one per-load SuperProcure bid
  // cap - so the retraction is not cosmetic. It rides the accepted-write rail (raiseAuthRestored),
  // never a reconnect, because a reconnect is a read and proves nothing about write scope.
  {
    const n = fakeNotifier();
    raiseAuthRestored(n, { accountId: 'rallis', accountLabel: 'rallis', since: 1700000000000, downForMs: 20 * MINUTE, deskCustomer: 'Rallis' });
    await new Promise((r) => setImmediate(r));

    const desk = n.calls.filter((c) => c.kind === 'desk_notice');
    ok(n.calls.filter((c) => c.kind === 'error').length === 1, 'the admin all-clear is unchanged - still one error alert');
    ok(desk.length === 1, 'and the customer group gets the matching retraction');
    ok(desk[0].payload.sessionAlert === 'restored' && templateFor('desk_notice', desk[0].payload) === 'session_restored',
      'routed to the session_restored template');
    ok(desk[0].payload.shipper === 'Rallis' && desk[0].payload.accountWide === true,
      'on the same customer scope, with the same account-wide routing as the stop-claim');
    ok(/^Bidding has resumed for Rallis/.test(desk[0].payload.detail), 'and it withdraws the claim in the same words the desk was told it in');
    ok(/No more manual quoting needed/.test(desk[0].payload.detail), 'explicitly ending the hand-quoting instruction');
    ok(desk[0].opts.dedupeKey === 'sp_auth_restored_desk_rallis_1700000000000',
      'keyed to the episode, so one outage closes with exactly one retraction');

    const n2 = fakeNotifier();
    raiseAuthRestored(n2, { accountId: 'primary', accountLabel: 'Primary', since: 1700000000000 });
    await new Promise((r) => setImmediate(r));
    ok(n2.calls.filter((c) => c.kind === 'desk_notice').length === 0,
      'an account with no single customer raises no customer retraction - the admin half is untouched');
  }

  // ================= the console mirror =================
  // Accounts.tsx hardcodes the leading rung to turn its "Expires soon" badge amber at the same
  // moment the WhatsApp goes out. Nothing links the two numbers at build time, and the ladder
  // change left the badge on the old 2h value - an operator-visible contradiction on the same
  // de-noising surface. Pinned by value so the next ladder edit fails here instead of on the desk.
  {
    const src = fs.readFileSync(path.join(__dirname, '../dashboard/src/pages/Accounts.tsx'), 'utf8');
    // Resolved rather than string-matched, so the pin survives the file expressing the same number
    // a different way (2 * HOUR, 30 * 60_000, 1800000 all reduce here). It is the VALUE that must
    // agree; how it is spelled is the console's business.
    const units = { MINUTE: 60_000 };
    for (const [, name, val] of src.matchAll(/const (DAY|HOUR|MINUTE) = ([0-9_]+);/g)) units[name] = Number(val.replace(/_/g, ''));
    const m = src.match(/const SHORT_SOON_MS = ([^;]+);/);
    ok(!!m, 'the console still declares SHORT_SOON_MS');
    const ms = m ? m[1].split('*').reduce((acc, term) => {
      const t = term.trim().replace(/_/g, '');
      return acc * (units[t] != null ? units[t] : Number(t));
    }, 1) : NaN;
    ok(ms === SHORT_WARN_MS[0],
      'and it equals the backend leading rung SHORT_WARN_MS[0] - the badge and the WhatsApp fire together');
  }

  // ================= deskCustomerFor: where the customer identity comes from =================
  {
    ok(deskCustomerFor({ accountId: 'rallis', deskCustomer: 'Rallis' }) === 'Rallis', 'an explicit deskCustomer wins');
    ok(deskCustomerFor({ accountId: 'rallis', allowlist: { shippers: ['Rallis India'] } }) === 'Rallis India',
      'a single-shipper allowlist IS the customer - a white-label tenant account bids for exactly one');
    ok(deskCustomerFor({ accountId: 'primary', allowlist: { shippers: ['Havells', 'Tata'] } }) === null,
      'two shippers is not a customer identity - null, not a guess');
    ok(deskCustomerFor({ accountId: 'primary' }) === null, 'and an account with no allowlist at all resolves to null');
  }

  // Completion sentinel - run-tests.js grades by exit code alone, so a file that exits early
  // (an unref'd timer, a swallowed throw) would otherwise score as a silent green pass.
  const EXPECTED_CHECKS = 60;
  assert.strictEqual(fail, 0, `${fail} checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - the file exited early`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
