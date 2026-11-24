'use strict';
/**
 * Sender re-link QR accelerator (offline). The problem it solves: the Maytapi sender logs out, every
 * send still answers success:true and delivers nothing, and recovery needs a physical QR scan whose
 * QR lived only in the web console - so whoever got the alert on their phone had to go find a
 * desktop. The accelerator fetches the live QR and delivers it as an image on the alert path.
 *
 * The invariant these tests exist to defend: a WhatsApp QR is a LIVE PAIRING CREDENTIAL, and the
 * pairing direction is the opposite of the intuitive one. Maytapi's instance for the slot is the
 * COMPANION device - it displays the QR and the PRIMARY phone scans it - so scanning does not hand
 * the scanner BRL's number. It re-points BRL's production sender slot at the SCANNING PHONE's
 * WhatsApp account, which means customer notifications start going out from that phone and its
 * private traffic starts arriving in BRL systems.
 *
 * Two consequences, both pinned here rather than left to instruction. The QR may reach the monitor's
 * named individual admin numbers and nothing else - never a group, never a broadcast, never anything
 * but a bare MSISDN - enforced structurally in scripts/lib/sender-qr.js (allowlist + throw, before
 * any network call), including a parity check that the standalone group-JID predicate has not
 * drifted from the app's own src/model/normalizePhone.js. And because 'active' is not the same as
 * 'ours', a slot that comes back on a DIFFERENT number must never read as recovery: classifyRebind()
 * / bindingGate() are exercised below for the mismatch case on every surface that can serve or push
 * a code.
 *
 * Everything runs against an injected transport - no network, no filesystem, no cron.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isGroupJid, assertIndividualRecipient, qrEligibleStatus, normalizeSlotStatus, qrDeliveryEnabled,
  parseAlertRecipients, fetchQr, fetchPhones, sendQrImage, deliverQrRelink,
  displayMsisdn, relinkQrUrl, expectedSenderNumber, knownBrlNumbers,
  observedSenderNumber, readLastKnownNumber, classifyRebind, bindingGate,
  buildQrCaption, buildScanWarning, qrOutcome, renderRelinkQrPage, createRelinkQrHandler,
  QR_MAX_BYTES, DEFAULT_ALERT_TO, RELINK_QR_PATH, REBOUND_STATE, QR_ELIGIBLE_STATUSES,
  QR_PAGE_MAX_AGE_MS, QR_AUDIT_THROTTLE_MS, NO_BASELINE_WARNING,
} = require('./lib/sender-qr');
// #77's hardened sibling picker - the monitor now feeds its result into the QR tier instead of the
// QR module carrying its own copy. Imported here so the convergence is actually exercised.
const { pickSiblingVia, decideQrBurst } = require('./monitor-wa-sender');
// The app's own predicate - imported ONLY by this test (never by the standalone monitor) so the
// copy in sender-qr.js can be proven identical rather than assumed identical.
const { isGroupJid: appIsGroupJid } = require('../src/model/normalizePhone');
// Same idea for the status parser: normalizeSlotStatus() is a deliberate copy of this, and the
// parity block below runs both over one vector table so the copy cannot drift silently.
const { WhatsAppClient } = require('../src/notify/whatsapp');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// COMPLETION SENTINEL - this file needs one more than most.
//
// Every assertion lives inside one async IIFE, and an await that NEVER SETTLES does not fail: it
// drains the event loop, and Node exits 0 having printed nothing. scripts/run-tests.js scores a file
// purely on its exit status, so that presents as a silent PASS with zero assertions run.
//
// Not hypothetical here. The stalled-transport block below deliberately awaits work that never
// resolves, bounded only by withDeadline() - so any regression in that bound (including something as
// quiet as unref'ing the timer, which stops it holding the loop open) shows up as exactly this: a
// green, wordless, zero-assertion run. Caught during this PR, by this guard.
let completed = false;
process.on('exit', (code) => {
  if (completed || code !== 0) return;
  console.error('\n  FAIL - the suite exited before completing: an await never settled.');
  console.error('         Exit 0 with no result line is NOT a pass - see the completion sentinel at the top of this file.');
  process.exitCode = 1;
});

// A minimal valid PNG: the 8-byte signature plus a little filler. Real QRs are ~6 KB; the shape is
// what matters here (fetchQr validates the signature, not the image contents).
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]);
const PNG_B64 = PNG.toString('base64');

const CREDS = { base: 'https://api.maytapi.com/api', productId: 'prod-a9bf', token: 'tok-5379' };
const SENDER = '128023';   // the logged-out sender
const SIBLING = '136151';  // the healthy phone the QR is sent FROM

// A transport that serves the QR PNG on /qrCode and accepts sendMessage, recording every call.
function qrTransport({ png = PNG, qrStatus = 200, sendOk = true, throwOn = null } = {}) {
  const fn = async (url, opts) => {
    fn.calls.push({ url, opts });
    if (throwOn && url.includes(throwOn)) throw new Error('boom');
    if (/\/qrCode$/.test(url)) {
      fn.qrCalls += 1;
      if (qrStatus !== 200) return { ok: false, status: qrStatus, arrayBuffer: async () => Buffer.alloc(0) };
      return { ok: true, status: 200, arrayBuffer: async () => png };
    }
    fn.sendCalls.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => (sendOk ? { success: true, data: { msgId: 'm1' } } : { success: false, message: 'phone not ready' }) };
  };
  fn.calls = []; fn.qrCalls = 0; fn.sendCalls = [];
  return fn;
}

const PHONES = [
  { id: 128023, number: null, status: 'qr-screen' },  // the down sender
  { id: 136151, number: '919594964196', status: 'active' },
  { id: 126187, number: null, status: 'idle' },
];

function deliverArgs(over = {}) {
  return Object.assign({
    base: CREDS.base, productId: CREDS.productId, token: CREDS.token,
    senderPhoneId: SENDER, senderStatus: 'qr-screen', via: SIBLING,
    recipients: ['919356252711', '919594937777'], enabled: true,
  }, over);
}

(async () => {
  // =========================================================================================
  // THE SECURITY INVARIANT: the QR never reaches a group.
  // =========================================================================================

  // ---- the group-JID predicate has not drifted from the app's ----
  {
    const vectors = [
      '120363012345678901@g.us', '919356252711-1610000000@g.us', '120363@G.US',
      '919356252711@c.us', '919356252711', '', '  120363012345678901@g.us  ',
      'status@broadcast', '120363012345678901@g.us.evil', 'abc@g.us', '@g.us',
    ];
    const drift = vectors.filter((v) => isGroupJid(v) !== appIsGroupJid(v));
    ok(drift.length === 0,
      `the standalone group-JID predicate matches src/model/normalizePhone.js on every vector (drifted: ${JSON.stringify(drift)})`);
    ok(isGroupJid('120363012345678901@g.us') === true, 'a modern all-digit group JID is recognised as a group');
    ok(isGroupJid('919356252711-1610000000@g.us') === true, 'a legacy <creator>-<timestamp> group JID is recognised as a group');
    ok(isGroupJid('919356252711') === false, 'a bare individual number is not a group');
  }

  // ---- assertIndividualRecipient REFUSES anything that is not a bare individual number ----
  {
    ok(assertIndividualRecipient('919356252711') === '919356252711', 'a bare MSISDN passes and is returned clean');
    ok(assertIndividualRecipient('  919356252711  ') === '919356252711', 'surrounding whitespace is trimmed, not rejected');

    assert.throws(() => assertIndividualRecipient('120363012345678901@g.us'), /GROUP/,
      'a group JID must THROW, naming the group rule');
    ok(true, 'a modern group JID is refused with a group-specific error');
    assert.throws(() => assertIndividualRecipient('919356252711-1610000000@g.us'), /GROUP/);
    ok(true, 'a legacy group JID is refused with a group-specific error');
    assert.throws(() => assertIndividualRecipient('919356252711@c.us'), /JID/);
    ok(true, 'an individual @c.us JID is refused (allowlist is a bare MSISDN only)');
    assert.throws(() => assertIndividualRecipient('status@broadcast'), /JID/);
    ok(true, 'a broadcast JID is refused');
    assert.throws(() => assertIndividualRecipient(''), /empty/);
    ok(true, 'an empty recipient is refused');
    assert.throws(() => assertIndividualRecipient(null), /empty/);
    ok(true, 'a null recipient is refused');
    assert.throws(() => assertIndividualRecipient('not-a-number'), /MSISDN/);
    ok(true, 'a non-numeric recipient is refused');
    assert.throws(() => assertIndividualRecipient('+91 93562 52711'), /MSISDN/);
    ok(true, 'a formatted number is refused rather than silently normalised (the send site is not a parser)');

    // THE failure this guard exists for: the codebase's other transport digit-strips its recipient,
    // which would turn a group JID into a plausible number and send successfully to the wrong place.
    // Here it must refuse instead of coercing.
    assert.throws(() => assertIndividualRecipient('120363012345678901@g.us'), /REFUSED/);
    ok(true, 'a group JID is REFUSED, never digit-stripped into a plausible-looking phone number');
  }

  // ---- a group in the recipient list is refused at the SEND SITE, before any network call ----
  {
    const t = qrTransport();
    const out = await deliverQrRelink(deliverArgs({
      recipients: ['919356252711', '120363012345678901@g.us', '919594937777'], transport: t,
    }));
    ok(out.sent === 2 && out.refused === 1, 'a group JID mixed into the recipients is refused while the valid DMs still get the QR');
    const targets = t.sendCalls.map((b) => b.to_number);
    ok(!targets.some((n) => String(n).includes('@')), 'no JID of any kind reached the wire');
    ok(!targets.some((n) => n === '120363012345678901' || n === '120363012345678901@g.us'),
      'the group is absent from the wire in BOTH its JID form and any digit-stripped form');
    ok(targets.join(',') === '919356252711,919594937777', 'exactly the two individual admin numbers were sent to');
  }

  // ---- a recipient list that is ONLY groups sends nothing at all ----
  {
    const t = qrTransport();
    const out = await deliverQrRelink(deliverArgs({ recipients: ['120363012345678901@g.us'], transport: t }));
    ok(out.sent === 0 && out.refused === 1, 'an all-group recipient list delivers nothing');
    ok(t.sendCalls.length === 0, 'not a single sendMessage was issued for a group-only recipient list');
  }

  // =========================================================================================
  // HAPPY PATH: the QR is fetched and delivered to the individual admin DMs on a down-alert.
  // =========================================================================================
  {
    const t = qrTransport();
    const out = await deliverQrRelink(deliverArgs({ transport: t }));
    ok(out.attempted === true && out.fetched === true, 'a down sender triggers a QR fetch');
    ok(out.sent === 2 && out.refused === 0 && out.failed === 0, 'the QR went to both configured admin DMs');
    ok(out.bytes === PNG.length, 'the fetched byte count is reported for the log line');

    // the QR is read from the purpose-built endpoint, on the DOWN sender's slot
    const qrUrl = t.calls.find((c) => /qrCode/.test(c.url)).url;
    ok(qrUrl === `${CREDS.base}/${CREDS.productId}/${SENDER}/qrCode`, 'the QR is fetched from /{product}/{downSender}/qrCode');
    ok(!t.calls.some((c) => /\/screen/.test(c.url)),
      'the /screen endpoint is NEVER called (on an active phone it returns a screenshot of the live WhatsApp-Web session)');
    ok(t.calls.find((c) => /qrCode/.test(c.url)).opts.headers['x-maytapi-key'] === CREDS.token, 'the QR read is authenticated');

    // the send rides the HEALTHY sibling, never the down sender
    const sendUrl = t.calls.find((c) => /sendMessage/.test(c.url)).url;
    ok(sendUrl === `${CREDS.base}/${CREDS.productId}/${SIBLING}/sendMessage`, 'the QR is sent FROM the healthy sibling phone');
    ok(!sendUrl.includes(`/${SENDER}/sendMessage`), 'the QR is never sent from the down sender itself');

    // Maytapi's documented base64-image wire shape (their own nodejs example, the media64 case):
    // { to_number, type:'image', text:<caption>, message:'data:image/png;base64,...' }
    const body = t.sendCalls[0];
    ok(body.type === 'image', "the wire type is 'image'");
    ok(body.message === `data:image/png;base64,${PNG_B64}`, 'the image rides `message` as a data URI');
    ok(typeof body.text === 'string' && body.text.length > 0, 'the caption rides `text`, not `message`');
    ok(/Linked Devices/.test(body.text), 'the caption tells the operator exactly where to scan');
    ok(/20 seconds/.test(body.text), 'the caption warns that the QR expires in ~20s');
  }

  // ---- the QR is re-fetched per alert (it rotates ~20s), never cached across alerts ----
  {
    const t = qrTransport();
    await deliverQrRelink(deliverArgs({ transport: t }));
    await deliverQrRelink(deliverArgs({ transport: t })); // the cooldown re-alert
    ok(t.qrCalls === 2, 'each alert re-fetches a fresh QR - a cooldown re-alert never re-sends a stale one');
  }

  // =========================================================================================
  // A HEALTHY SENDER GETS NO QR.
  // =========================================================================================
  {
    for (const st of ['active', 'ACTIVE', ' Active ']) {
      const t = qrTransport();
      const out = await deliverQrRelink(deliverArgs({ senderStatus: st, transport: t }));
      ok(out.attempted === false && out.sent === 0, `an ${st.trim()} sender triggers no QR delivery`);
      ok(t.calls.length === 0, `an ${st.trim()} sender causes ZERO maytapi calls (no fetch, no send)`);
    }
    // fail-closed on an unreadable status: never pull a screen-family image for a phone we cannot
    // prove is logged out.
    for (const st of [null, undefined, '', 'unknown']) {
      const t = qrTransport();
      const out = await deliverQrRelink(deliverArgs({ senderStatus: st, transport: t }));
      ok(out.attempted === false && t.calls.length === 0, `an unreadable status (${JSON.stringify(st)}) is fail-CLOSED - no fetch`);
    }
    // every genuinely-down state IS eligible
    for (const st of ['qr-screen', 'idle', 'loading', 'disabled']) {
      ok(qrEligibleStatus(st) === true, `${st} is a QR-eligible (not-active) state`);
    }
    ok(qrEligibleStatus('active') === false, 'active is never QR-eligible');

    // ---- THE GATE IS AN ALLOWLIST, NOT A DENYLIST (r1 sub-threshold, settled by live probe) ----
    //
    // It was `s !== 'active'` over `String(status)`, which admits ANY unrecognised string. The
    // object form Maytapi actually returns therefore stringified to '[object Object]' and sailed
    // through: a healthy `{state:'active'}` slot classified as QR-eligible. Two other normalizers in
    // this repo (src/notify/whatsapp.js, scripts/verify-whatsapp-setup.js) already handle that shape
    // precisely because the API has returned it; this gate was the outlier.
    //
    // WHAT AN ACTIVE SLOT REALLY ANSWERS, live-probed 2026-07-25 read-only against slot 128023 while
    // it was active on 918882034647:
    //     GET {base}/{product}/128023/qrCode -> 200, application/json, 53 bytes,
    //     {"success":false,"message":"Could not find qr code."}
    // So /qrCode is genuinely QR-only and no screenshot could ever have leaked through this path -
    // but note res.ok is TRUE for that response, so the only thing that refused it was fetchQr()'s
    // PNG magic-byte check, one layer below the gate that was supposed to stop it. The board read in
    // the same probe is pinned below.
    ok(qrEligibleStatus({ state: 'active' }) === false,
      'an OBJECT status of a healthy slot is refused - String()-coercing it to "[object Object]" used to read as eligible');
    ok(qrEligibleStatus({ status: 'active' }) === false, 'and via the {status:...} shape');
    ok(qrEligibleStatus({ loggedIn: true }) === false, 'and via the {loggedIn:true} shape');
    ok(qrEligibleStatus({ state: 'qr-screen' }) === true, 'an object-form LOGGED-OUT slot is still eligible - the parse is fixed, not disabled');
    for (const st of [42, [], {}, { state: 42 }, 'ACTIVE ', 'connected', 'sleeping', 'screen']) {
      ok(qrEligibleStatus(st) === false,
        `an unrecognised status (${JSON.stringify(st)}) fails CLOSED - only enumerated states are eligible`);
    }
    ok(QR_ELIGIBLE_STATUSES.indexOf('active') === -1, 'active is excluded from the allowlist by construction, not by a separate check');

    // The live board shape, pinned so a future refactor cannot quietly assume something else.
    // Verbatim rows from the same 2026-07-25 probe (8 slots; status was a bare string on all 8,
    // number was null on the two idle ones).
    {
      const LIVE_BOARD = [
        { id: 128025, number: '919594964684', status: 'active' },
        { id: 147227, number: null, status: 'idle' },
        { id: 128023, number: '918882034647', status: 'active' },
        { id: 126187, number: null, status: 'idle' },
      ];
      for (const row of LIVE_BOARD) {
        ok(typeof row.status === 'string', `the live board returns status as a bare string for slot ${row.id}`);
        ok(qrEligibleStatus(row.status) === (row.status !== 'active'),
          `slot ${row.id} (${row.status}) classifies the way the live shape demands`);
      }
    }

    // ---- PARITY: the copied status parser must not drift from the app's ----
    // normalizeSlotStatus() is a deliberate copy of WhatsAppClient.statusOf, copied rather than
    // imported because this module is shared with the standalone monitor (which imports nothing from
    // src/). Same discipline as the GROUP_JID_RE parity block: run both over one vector table so
    // drift is a test failure, not a silent hole.
    for (const v of [
      'active', 'ACTIVE', ' qr-screen ', 'idle', 'loading', 'disabled', '',
      { state: 'active' }, { state: 'LOADING' }, { status: 'qr-screen' },
      { loggedIn: true }, { connected: true }, { nothing: 'useful' },
      null, undefined, 42, [],
    ]) {
      const mine = normalizeSlotStatus(v);
      const theirs = WhatsAppClient.statusOf({ status: v });
      // statusOf does not trim; ours does, because a padded status must not miss the allowlist.
      ok(mine === theirs.trim(), `status parse parity for ${JSON.stringify(v)}: ${mine} === ${theirs.trim()}`);
    }
  }

  // =========================================================================================
  // FETCH FAILURE DEGRADES TO TODAY'S TEXT-ONLY ALERT - it never blocks or throws.
  // =========================================================================================
  {
    // HTTP error
    let t = qrTransport({ qrStatus: 500 });
    let out = await deliverQrRelink(deliverArgs({ transport: t }));
    ok(out.fetched === false && out.sent === 0 && /http 500/.test(out.reason), 'a QR HTTP 500 degrades to text-only with a reason');
    ok(t.sendCalls.length === 0, 'nothing is sent when the QR could not be fetched');

    // network throw
    t = qrTransport({ throwOn: 'qrCode' });
    out = await deliverQrRelink(deliverArgs({ transport: t }));
    ok(out.fetched === false && /network/.test(out.reason), 'a QR network throw degrades to text-only');

    // a non-PNG body (an error envelope or an HTML page) is never forwarded as if it were a QR
    t = qrTransport({ png: Buffer.from('{"success":false,"message":"phone is connected"}') });
    out = await deliverQrRelink(deliverArgs({ transport: t }));
    ok(out.fetched === false && /not a PNG/.test(out.reason), 'a non-PNG body is rejected, never shipped to admins as a QR');
    ok(t.sendCalls.length === 0, 'a non-PNG body results in zero sends');

    // an empty body
    t = qrTransport({ png: Buffer.alloc(0) });
    out = await deliverQrRelink(deliverArgs({ transport: t }));
    ok(out.fetched === false && /empty/.test(out.reason), 'an empty QR body degrades to text-only');

    // an implausibly large body is capped rather than base64'd into a send
    t = qrTransport({ png: Buffer.concat([PNG, Buffer.alloc(QR_MAX_BYTES + 10)]) });
    out = await deliverQrRelink(deliverArgs({ transport: t }));
    ok(out.fetched === false && /exceeds/.test(out.reason), 'an oversized body is refused by the size cap');

    // a send failure is counted but never thrown, and never stops the other recipient
    t = qrTransport({ sendOk: false });
    out = await deliverQrRelink(deliverArgs({ transport: t }));
    ok(out.failed === 2 && out.sent === 0, 'maytapi success:false on the send is a failure, not a silent ok');

    // deliverQrRelink NEVER rejects, whatever it is handed
    for (const bad of [undefined, {}, { transport: null }, deliverArgs({ recipients: null, transport: qrTransport() })]) {
      const r = await deliverQrRelink(bad);
      ok(r && typeof r === 'object' && r.sent === 0, 'deliverQrRelink resolves an object rather than rejecting, whatever the input');
    }
  }

  // ---- no sibling to send from: skip cleanly, the alert still stands ----
  {
    const t = qrTransport();
    const out = await deliverQrRelink(deliverArgs({ via: null, transport: t }));
    ok(out.attempted === false && /no active sibling/.test(out.reason), 'no healthy sibling -> the QR tier is skipped, not attempted');
    ok(t.calls.length === 0, 'no sibling means the QR is not even fetched');
  }

  // =========================================================================================
  // THE KNOB: DEFAULT OFF, and off -> byte-identical current behaviour (zero calls, zero effects).
  //
  // The push leg has never been exercised against a real Maytapi with a real ~6 KB QR, so a routine
  // deploy must not be able to start pushing pairing credentials on its own. Enabling is an explicit
  // operator act, taken after scripts/probe-sender-qr.js has confirmed the delivered image SCANS.
  // =========================================================================================
  {
    for (const v of [undefined, null, '', '0', 'false', 'no', 'off', 'OFF', ' False ', 'anything']) {
      ok(qrDeliveryEnabled({ SP_WA_QR_IN_ALERT: v }) === false, `SP_WA_QR_IN_ALERT=${JSON.stringify(v)} leaves the push tier OFF`);
    }
    for (const v of ['1', 'true', 'yes', 'on', ' ON ', 'True']) {
      ok(qrDeliveryEnabled({ SP_WA_QR_IN_ALERT: v }) === true, `SP_WA_QR_IN_ALERT=${JSON.stringify(v)} explicitly enables the push tier`);
    }
    ok(qrDeliveryEnabled({}) === false && qrDeliveryEnabled() === false,
      'unset -> OFF: an unprobed send leg cannot fire from a routine deploy');
    // The default must hold at the DELIVERY boundary too, not only in the predicate - a caller that
    // forgets to pass `enabled` must get the safe answer, not an accidental send.
    {
      const t = qrTransport();
      const args = deliverArgs({ transport: t });
      delete args.enabled;
      const out = await deliverQrRelink(args);
      ok(t.calls.length === 0 && out.attempted === false, 'deliverQrRelink defaults `enabled` to false - omitting it sends nothing');
    }

    const t = qrTransport();
    const out = await deliverQrRelink(deliverArgs({ enabled: false, transport: t }));
    ok(t.calls.length === 0, 'knob off -> ZERO maytapi calls: byte-identical to the pre-feature alert path');
    ok(out.attempted === false && out.sent === 0 && out.fetched === false, 'knob off -> nothing attempted, nothing fetched, nothing sent');
    ok(/SP_WA_QR_IN_ALERT/.test(out.reason), 'knob off is reported as the reason, so the log says why');
  }

  // =========================================================================================
  // THE BINDING GATE: never hand out a second pairing code for a slot already captured.
  // =========================================================================================
  {
    // Permissive where it cannot tell - refusing on an unknown binding would make re-linking
    // impossible on a fresh box and during every genuine outage (the board reports number:null
    // there, which is exactly when this feature is used).
    ok(bindingGate(null, '919594963615').allowed === true, 'a down slot (number:null) is still allowed - that is the normal re-link case');
    ok(bindingGate('919594963615', null).allowed === true, 'no expected number yet (fresh box) -> allowed, never a permanent block');
    ok(bindingGate('919594963615', '919594963615').allowed === true, 'the expected number -> allowed');
    ok(bindingGate('+91 95949 63615', '919594963615').allowed === true, 'formatting differences do not manufacture a mismatch');

    const bad = bindingGate('919000000009', '919594963615');
    ok(bad.allowed === false, 'a DEFINITIVE mismatch refuses');
    ok(bad.reason.includes(REBOUND_STATE), 'the refusal names the loud state, not a generic error');

    // ...and the refusal happens before any network call, like every other structural gate here.
    const t = qrTransport();
    const out = await deliverQrRelink(deliverArgs({
      enabled: true, transport: t, senderStatus: 'qr-screen',
      boundNumber: '919000000009', expectedNumber: '919594963615',
    }));
    ok(t.calls.length === 0, 'a re-bound slot -> ZERO maytapi calls (no fetch, no send)');
    ok(out.attempted === false && out.reason.includes(REBOUND_STATE),
      'a re-bound slot refuses the whole delivery and says why');
  }

  // =========================================================================================
  // Wiring helpers the monitor calls.
  // =========================================================================================
  {
    // recipients - ONE parser, now shared with the monitor's own text tier (the duplicate copy in
    // alertWaSibling was converged onto this once #77 landed).
    ok(parseAlertRecipients({}).join(',') === DEFAULT_ALERT_TO, 'recipients default to the configured admin numbers');
    ok(parseAlertRecipients({ MONITOR_ALERT_TO: ' 919000000001 , 919000000002 ' }).length === 2,
      'MONITOR_ALERT_TO is split and trimmed');
    ok(parseAlertRecipients({ MONITOR_ALERT_TO: '919000000001,,' }).length === 1, 'blank entries are dropped');

    // Sibling selection is no longer duplicated here: the monitor passes in #77's hardened
    // pickSiblingVia() result. Pinned in scripts/test-wa-sender-monitor.js, and pinned HERE as an
    // absence so a future edit cannot quietly resurrect a second, weaker picker in this module.
    ok(require('./lib/sender-qr').pickQrVia === undefined,
      'sender-qr.js exports no sibling picker of its own - #77 pickSiblingVia is the single source');
  }

  // ---- fetchQr / sendQrImage guard their own inputs ----
  {
    ok((await fetchQr({})).ok === false, 'fetchQr without creds fails cleanly rather than calling out');
    ok((await fetchQr({ base: 'b', productId: 'p', phoneId: '1', token: 't', transport: null })).ok === false,
      'fetchQr with no transport fails cleanly');
    await assert.rejects(() => sendQrImage({ to: '120363012345678901@g.us', base64: PNG_B64 }), /GROUP/);
    ok(true, 'sendQrImage refuses a group recipient BEFORE it checks creds or touches the network');
  }

  // =========================================================================================
  // THE INSTRUCTION NAMES THE HANDSET. The expensive mistake is not a wrong recipient (that is
  // refused above) - it is the right recipient scanning on the WRONG PHONE, which re-points BRL's
  // production sender at that phone's WhatsApp account. So every rendered instruction must say
  // which number, and what a wrong scan costs.
  // =========================================================================================
  {
    ok(displayMsisdn('918882034647') === '+91 88820 34647', 'an Indian MSISDN is rendered in a form a human can read off a handset');
    ok(displayMsisdn('+91 88820 34647') === '+91 88820 34647', 'a pre-formatted number normalises to the same display form');
    ok(displayMsisdn('12025550123') === '+12025550123', 'a non-Indian number is shown whole rather than mis-grouped');
    ok(displayMsisdn(null) === null && displayMsisdn('') === null && displayMsisdn('abc') === null,
      'an unusable number returns null so the caller omits the line instead of printing garbage next to a scan instruction');

    const cap = buildQrCaption({ senderPhoneId: SENDER, expectedNumber: '918882034647', qrUrl: 'https://bids.example.com/api/wa/relink-qr' });
    ok(cap.includes('+91 88820 34647'), 'the caption NAMES the handset that must scan, not just the opaque slot id');
    ok(/only from the phone/i.test(cap), 'the caption constrains WHICH handset before it gives the instruction');
    ok(/any other phone/i.test(cap) && /BRL's systems/i.test(cap),
      'the caption states what a scan from the wrong phone actually does (this is the destructive-misscan warning)');
    ok(cap.includes('Linked Devices'), 'the caption still tells the operator exactly where to scan');
    // Freshness honesty. The old caption promised a property the cooldown could not deliver; the
    // caption must now state the artifact's real life AND point at the path with no expiry to race.
    ok(/Fetched just now/.test(cap), 'the caption says when this code was fetched rather than implying it is durable');
    ok(/rotates about every 20 seconds/.test(cap) && /only good for a/.test(cap),
      'the caption states the ~20s lifetime plainly - it does not promise freshness the cadence cannot deliver');
    ok(/do not wait\s*\n?\s*for the next image/i.test(cap.replace(/\n/g, ' ')) || /do not wait/i.test(cap),
      'an already-expired image sends the reader to the live page, not to waiting for the next push');
    ok(/Always-live code/.test(cap) && cap.includes('https://bids.example.com/api/wa/relink-qr'),
      'the caption names the always-live path as the answer to expiry');
    ok(cap.includes('https://bids.example.com/api/wa/relink-qr'), 'the caption carries the always-fresh on-demand URL');
    ok(cap.indexOf(SENDER) !== -1, 'the caption still identifies the slot for the console fallback');

    // no number available anywhere -> say so, never fall back to a vague "that number"
    const capNoNum = buildQrCaption({ senderPhoneId: SENDER, expectedNumber: null, qrUrl: null });
    ok(!/that number/i.test(capNoNum) && /could not be read/i.test(capNoNum),
      'with no known number the caption admits it and points at the console, rather than referring to a number it never supplies');

    // the caption is what actually rides the wire
    const t = qrTransport();
    await deliverQrRelink(deliverArgs({ transport: t, expectedNumber: '918882034647', qrUrl: 'https://bids.example.com/api/wa/relink-qr' }));
    ok(t.sendCalls.length === 2 && t.sendCalls.every((b) => b.text.includes('+91 88820 34647')),
      'the delivered caption on the wire carries the handset number for every recipient');
    ok(t.sendCalls[0].text.includes('https://bids.example.com/api/wa/relink-qr'), 'the delivered caption on the wire carries the live-QR URL');
  }

  // ---- the on-demand page URL is built from the app's own public base ----
  {
    ok(relinkQrUrl({ SP_BASE_URL: 'https://bids.example.com' }) === `https://bids.example.com${RELINK_QR_PATH}`, 'the QR page URL is derived from SP_BASE_URL');
    ok(relinkQrUrl({ SP_BASE_URL: 'https://bids.example.com/' }) === `https://bids.example.com${RELINK_QR_PATH}`, 'a trailing slash on the base does not double up');
    ok(relinkQrUrl({}) === null, 'no SP_BASE_URL -> no URL advertised (the alert names the console instead)');
    ok(relinkQrUrl({ SP_BASE_URL: 'http://localhost:4103' }) === null,
      'a localhost base is refused - a URL only the box itself can open is worse than none in an alert read on a phone');
  }

  // =========================================================================================
  // RE-BIND VERIFICATION: 'active' is not the same as 'ours'.
  // =========================================================================================
  {
    ok(classifyRebind('918882034647', '918882034647').verdict === 'match', 'the same number back is a genuine recovery');
    ok(classifyRebind('+91 88820 34647', '918882034647').verdict === 'match', 'formatting differences are not a mismatch');
    ok(classifyRebind('919999999999', '918882034647').verdict === 'mismatch', 'a DIFFERENT number on the slot is a mismatch, not a recovery');
    ok(classifyRebind('919999999999', null).verdict === 'first-run', 'no persisted number -> first-run: record it, never block');
    ok(classifyRebind(null, '918882034647').verdict === 'first-run', 'an unreadable live number cannot be judged a mismatch');
    ok(classifyRebind('919999999999', '918882034647').expected === '918882034647',
      'the mismatch carries the EXPECTED number too, so the alert can tell the operator what to restore');

    // ---- THE EXPECTATION IS AN OBSERVATION, AND NOTHING ELSE ----
    // SP_MAYTAPI_SENDER_NUMBER is gone. It declared one owning MSISDN and outranked the observation,
    // which made every legitimate handset swap an urgent alarm whose only remedy was to re-type the
    // declaration. What separates a swap from a capture is membership (knownBrlNumbers), not identity.
    ok(expectedSenderNumber({ lastKnownNumber: '918882034647' }) === '918882034647',
      'the expectation is what the last healthy run observed');
    ok(expectedSenderNumber({ lastKnownNumber: '+91 88820 34647' }) === '918882034647',
      'and it is digit-normalised, so a hand-edited state file is not read as a different number');
    ok(expectedSenderNumber({}) === null, 'nothing known -> null, which callers must treat as "cannot verify", never as "matches"');
    ok(expectedSenderNumber({}, { SP_MAYTAPI_SENDER_NUMBER: '911111111111' }) === null,
      'THE PIN IS GONE: a leftover SP_MAYTAPI_SENDER_NUMBER on a box is inert and cannot resurrect the old behaviour');
    ok(observedSenderNumber({ lastKnownNumber: '918882034647' }) === '918882034647' && observedSenderNumber({}) === null,
      'the observation reader answers null when there is nothing on record');

    // ---- IS THIS NUMBER ONE OF BRL'S? (the test that replaced the pin) ----
    // Two sources unioned: the other slots on BRL's own Maytapi board, and the staff allowlist.
    const ROSTER = path.join(os.tmpdir(), `roster-${Date.now()}.json`);
    fs.writeFileSync(ROSTER, JSON.stringify({ allowlist: { numbers: ['+919594964196', '918657435077'] } }));
    const BOARD = [
      { id: 128023, number: '918882034647', status: 'active' },
      { id: 136151, number: '919594964196', status: 'active' },
      { id: 127918, number: '919594964195', status: 'active' },
    ];
    const known = knownBrlNumbers({ phones: BOARD, senderId: '128023', rosterFile: ROSTER });
    ok(known.has('919594964195'), 'a number holding another slot on BRL\'s own Maytapi product is BRL\'s by construction');
    ok(known.has('919594964196'), 'and so is one on the staff allowlist');
    ok(known.has('918657435077'), 'the roster is digit-normalised, so a bare entry and a +91 entry both land');
    ok(!known.has('918882034647'),
      'THE SUBJECT SLOT IS EXCLUDED - after a re-bind its number IS whatever just captured it, so counting it would let any phone authorise itself');
    ok(!known.has('919999999999'), 'and an unrelated number is not in the set');

    const noRoster = knownBrlNumbers({ phones: BOARD, senderId: '128023', rosterFile: path.join(os.tmpdir(), 'nope-roster.json') });
    ok(noRoster.has('919594964195') && !noRoster.has('918657435077'),
      'a missing roster degrades to the board half rather than throwing - and it fails CLOSED, since a smaller set alarms more, never less');
    ok(knownBrlNumbers({}).size === 0, 'no board and no roster yields an empty set, which treats every move as a capture');
    fs.unlinkSync(ROSTER);
  }

  // =========================================================================================
  // THE ON-DEMAND ENDPOINT (delivery layer 1 - the primary path).
  // =========================================================================================
  {
    const BOARD_DOWN = [{ id: 128023, number: null, status: 'qr-screen' }, { id: 136151, number: '919594964196', status: 'active' }];
    const BOARD_UP = [{ id: 128023, number: '918882034647', status: 'active' }, { id: 136151, number: '919594964196', status: 'active' }];

    function webTransport(board, { qrStatus = 200, png = PNG } = {}) {
      const fn = async (url, opts) => {
        fn.calls.push(String(url));
        if (/listPhones$/.test(url)) return { ok: true, status: 200, json: async () => ({ data: board }) };
        if (/\/qrCode$/.test(url)) {
          fn.qrCalls += 1;
          if (qrStatus !== 200) return { ok: false, status: qrStatus, arrayBuffer: async () => Buffer.alloc(0) };
          return { ok: true, status: 200, arrayBuffer: async () => png };
        }
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      };
      fn.calls = []; fn.qrCalls = 0;
      return fn;
    }
    function fakeRes() {
      const r = { headers: {}, statusCode: 200, body: null };
      r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
      r.status = (n) => { r.statusCode = n; return r; };
      r.json = (o) => { r.body = o; return r; };
      r.send = (b) => { r.body = b; return r; };
      return r;
    }
    const CREDS_WEB = { endpoint: CREDS.base, productId: CREDS.productId, phoneId: SENDER, token: CREDS.token };
    // Every construction below carries an operator resolver, because the handler now refuses without
    // one. See the fail-closed block further down for why that default is the point.
    const ADMIN = () => ({ user: 'ops' });
    const qrHandler = (opts) => createRelinkQrHandler(Object.assign({ currentAdmin: ADMIN }, opts));

    // ---- THE HANDLER'S OWN AUTH CHECK: it does not delegate 100% of its auth to middleware ----
    // The route is mounted below the app's /api session gate and inherits it. This is the belt to
    // that brace: the endpoint hands out a live PAIRING credential, so it re-checks for itself and
    // fails closed if the gate is ever reordered, split, or has a route block inserted above it.
    // A handler built with NO resolver refuses everything - "I cannot tell who this is" must never
    // resolve to "serve them the QR".
    {
      const t = webTransport(BOARD_DOWN);
      const res = fakeRes();
      await createRelinkQrHandler({ creds: CREDS_WEB, transport: t })({ query: {} }, res);
      ok(res.statusCode === 401, 'a handler with NO currentAdmin resolver refuses - misconfigured auth fails CLOSED, it does not fall open');
      ok(t.calls.length === 0, 'the unauthenticated refusal reads NOTHING from maytapi - not even the phone board');

      const res2 = fakeRes();
      await createRelinkQrHandler({ creds: CREDS_WEB, transport: webTransport(BOARD_DOWN), currentAdmin: () => null })({ query: { img: '1' } }, res2);
      ok(res2.statusCode === 401, 'no session -> 401 on the ?img=1 leg too, which is the leg that carries the credential');

      const res3 = fakeRes();
      await createRelinkQrHandler({ creds: CREDS_WEB, transport: webTransport(BOARD_DOWN), currentAdmin: () => { throw new Error('session store down'); } })({ query: {} }, res3);
      ok(res3.statusCode === 401, 'a THROWING session resolver is a refusal, not a 500 and never a serve');
    }

    // ---- a HEALTHY sender is refused: no page, no image, and NOTHING is read from maytapi ----
    {
      const t = webTransport(BOARD_UP);
      const res = fakeRes();
      await qrHandler({ creds: CREDS_WEB, transport: t })({ query: {} }, res);
      ok(res.statusCode === 409, 'an ACTIVE sender gets 409 from the QR page - there is nothing to re-link');
      ok(t.qrCalls === 0, 'an ACTIVE sender causes ZERO /qrCode reads (the /screen hazard fail-closed rule, same as the alert path)');
      ok(typeof res.body === 'object' && /active/i.test(res.body.error), 'the 409 says what the slot is actually doing rather than a bare refusal');
      ok(res.headers['cache-control'] === 'no-store', 'even the refusal is no-store');

      // and the image leg is gated identically - the gate is not page-only
      const res2 = fakeRes();
      const t2 = webTransport(BOARD_UP);
      await qrHandler({ creds: CREDS_WEB, transport: t2 })({ query: { img: '1' } }, res2);
      ok(res2.statusCode === 409 && t2.qrCalls === 0, 'the ?img=1 leg is gated on eligibility too, not just the HTML page');
    }

    // ---- an unreadable status is fail-CLOSED here as well ----
    {
      const t = webTransport([{ id: 128023, number: null, status: 'unknown' }]);
      const res = fakeRes();
      await qrHandler({ creds: CREDS_WEB, transport: t })({ query: {} }, res);
      ok(res.statusCode === 409 && t.qrCalls === 0, 'a status we cannot prove is logged-out serves no QR (fail-closed)');
    }

    // ---- a DOWN sender gets the self-refreshing page ----
    {
      const t = webTransport(BOARD_DOWN);
      const res = fakeRes();
      await qrHandler({ creds: CREDS_WEB, transport: t, senderNumberProvider: () => '918882034647' })({ query: {} }, res);
      ok(res.statusCode === 200, 'a logged-out sender gets the QR page');
      ok(res.headers['cache-control'] === 'no-store', 'the page is Cache-Control: no-store - a pairing credential must not sit in a cache or the bfcache');
      ok(/text\/html/.test(res.headers['content-type']), 'the page is served as HTML');
      ok(t.qrCalls === 0, 'rendering the page does not itself fetch a QR - the <img> does, so what is on screen is always freshly pulled');
      ok(res.body.includes('+91 88820 34647'), 'the page NAMES the handset that must scan');
      ok(/any other phone/i.test(res.body), 'the page carries the wrong-handset warning, same as the caption');
      ok(res.body.includes(`${RELINK_QR_PATH}?img=1`), 'the page image points back at this same route');
      ok(/setInterval/.test(res.body), 'the page re-pulls the QR on a timer rather than serving one snapshot');
      ok(/http-equiv="refresh"/.test(res.body), 'a no-JS client still gets a refreshing page');
    }

    // ---- A STALLED MAYTAPI MUST NOT HANG THE OPERATOR'S REQUEST (r1 Finding 6) ----
    //
    // Both reads were issued bare. On the monitor's cron path that was survivable; on a SYNCHRONOUS
    // operator request it is not, because undici's default headers/body timeouts are on the order of
    // minutes. An endpoint that accepts the connection and then stalls therefore left the handler
    // awaiting with nothing written - and the page cannot represent that: every one of its terminal
    // and retry states hangs off img.onerror, which an in-flight request NEVER fires. So it rendered
    // "Loading a live code..." forever while the 10s timer opened a fresh stalled upstream request
    // every tick, up to ~90 of them against the same Maytapi account the monitor's health read and
    // the bidder's customer notifications share. The correlation is the worst part: the moment an
    // operator opens this page is the moment a Maytapi slowdown is most likely.
    //
    // These tests could not pass before the fix - that was the finding.
    {
      // A transport that accepts the call and never settles, on each leg in turn.
      const stalls = (which) => {
        const fn = async (url) => {
          if (which === 'board' || /qrCode$/.test(String(url))) return new Promise(() => {});
          if (/listPhones$/.test(url)) return { ok: true, status: 200, json: async () => ({ data: BOARD_DOWN }) };
          return new Promise(() => {});
        };
        return fn;
      };

      const t0 = Date.now();
      const res = fakeRes();
      await qrHandler({ creds: CREDS_WEB, transport: stalls('board'), timeoutMs: 40 })({ query: {} }, res);
      ok(res.statusCode === 502, 'a stalled phone-board read SETTLES as a 502 rather than hanging the request open');
      ok(/timed out/.test(String(res.body && res.body.error)), 'and the 502 says it timed out, so the page and the log both name the real cause');
      ok(Date.now() - t0 < 3000, 'it settles promptly - bounded by the deadline, not by undici defaults measured in minutes');

      const res2 = fakeRes();
      await qrHandler({ creds: CREDS_WEB, transport: stalls('qr'), timeoutMs: 40 })({ query: { img: '1' } }, res2);
      ok(res2.statusCode === 502, 'a stalled /qrCode read on the CREDENTIAL leg settles too - this is the leg the <img> polls');
      ok(/timed out/.test(String(res2.body && res2.body.error)), 'and it reports the timeout rather than an ambiguous empty failure');

      // The 502 is the status the page already has a state for, so a stall now renders as the
      // "Maytapi did not return a QR just now" branch instead of an eternal "Loading...".
      const page = renderRelinkQrPage({ senderPhoneId: SENDER, senderStatus: 'qr-screen', expectedNumber: '918882034647' });
      ok(/o\.s===502/.test(page), 'the page still branches on 502, which is what the bounded fetch now degrades a stall into');
    }

    // ---- the page has a client-side watchdog, and never stacks overlapping requests ----
    // The server-side deadline cannot cover the leg the server never sees: a response that dies
    // between nginx and the phone. Without a client watchdog that is still an eternal "Loading...".
    {
      const page = renderRelinkQrPage({ senderPhoneId: SENDER, senderStatus: 'qr-screen', expectedNumber: '918882034647', refreshMs: 10000 });
      // ---- the dark theme reaches the one interactive control (r1 Finding 4) ----
      // The page styled h1/.warn/img/p/code/.meta/#st and had no `a` rule at all, so the single
      // anchor inherited the UA default #0000EE on #111 - about 2.0:1, against the 4.5:1 WCAG 2.2
      // SC 1.4.3 requires, and 1.7:1 once visited. It is revealed ONLY in the 401 state, which is an
      // operator whose session died mid-outage looking for the one route back, on a phone.
      ok(/a\{color:#7cc4ff\}/.test(page), 'links are given a colour that clears 4.5:1 on the #111 background (~10:1)');
      ok(/a:visited\{color:#c8a2ff\}/.test(page), 'and the VISITED state too - it is the state the link is actually in on a second outage');
      ok(/a:focus-visible\{/.test(page), 'and a focus ring, because the UA default is tuned for light backgrounds');
      ok(/<a href="\/">/.test(page), 'the 401 recovery link is still present - the contrast fix did not remove the affordance it fixes');
      // ---- the QR must survive being upscaled into a ~288px box on a phone ----
      ok(/image-rendering:pixelated/.test(page),
        'the QR keeps hard module edges when scaled - a smoothed QR photographs fine and simply will not scan');

      ok(/is not answering/.test(page), 'a stalled leg surfaces as an explicit "not answering" state rather than a permanent Loading');
      ok(/if\(pending\)return;/.test(page), 'a refresh tick is skipped while a request is still outstanding - the ticks cannot stack ~90 stalled upstreams');
      ok(/removeAttribute\('src'\)/.test(page), 'the watchdog abandons the stalled request instead of leaving the connection open');
      ok(/20000/.test(page), 'the watchdog patience is twice the refresh interval, derived from it rather than hardcoded separately');
    }

    // ---- ?img=1 returns freshly fetched PNG bytes ----
    {
      const t = webTransport(BOARD_DOWN);
      const res = fakeRes();
      await qrHandler({ creds: CREDS_WEB, transport: t })({ query: { img: '1', t: '123' } }, res);
      ok(res.statusCode === 200 && Buffer.isBuffer(res.body) && res.body.equals(PNG), 'the image leg returns the PNG bytes');
      ok(res.headers['content-type'] === 'image/png', 'the image leg is served as image/png');
      ok(res.headers['cache-control'] === 'no-store', 'the image leg is no-store too - this is the leg that carries the credential');
      ok(t.qrCalls === 1, 'exactly one FRESH /qrCode read per image request (this is what keeps it inside the ~20s rotation)');
    }

    // ---- failures are honest, and never render a page pretending to hold a QR ----
    {
      const t = webTransport(BOARD_DOWN, { qrStatus: 500 });
      const res = fakeRes();
      await qrHandler({ creds: CREDS_WEB, transport: t })({ query: { img: '1' } }, res);
      ok(res.statusCode === 502 && /http 500/.test(res.body.error), 'a maytapi QR failure surfaces as 502 with the reason');

      const res2 = fakeRes();
      await qrHandler({ creds: {}, transport: webTransport(BOARD_DOWN) })({ query: {} }, res2);
      ok(res2.statusCode === 503, 'an instance with no WhatsApp creds answers 503 rather than half-rendering');

      const tNoBoard = async () => { throw new Error('boom'); };
      const res3 = fakeRes();
      await qrHandler({ creds: CREDS_WEB, transport: tNoBoard })({ query: {} }, res3);
      ok(res3.statusCode === 502 && /listPhones/.test(res3.body.error), 'an unreadable phone board is 502, never an ungated render');
    }

    // ---- the page escapes what it interpolates ----
    {
      const html = renderRelinkQrPage({ senderPhoneId: '<script>x</script>', senderStatus: 'qr-screen', expectedNumber: '918882034647' });
      ok(!html.includes('<script>x</script>'), 'interpolated values are HTML-escaped (they come off maytapi, so they are untrusted)');
    }

    // ---- THE AUTH GATE ----
    // The endpoint-level auth assertions used to live here as a String.indexOf comparison of where
    // the route and the gate appear in server.js. That was the wrong instrument and it cost a live
    // bypass: source ORDER was correct the whole time while route MATCHING disagreed with the
    // gate's prefix test, so `/API/wa/relink-qr` sailed past a green suite. They are now real
    // requests against a really-booted app in scripts/test-relink-qr-auth.js. Only the path shape
    // this file actually owns is checked here.
    ok(RELINK_QR_PATH.startsWith('/api/'), 'the QR route lives under /api/ so the session gate matches it at all');

    // ---- THE PAGE HAS MORE THAN ONE STATE (r2 Finding 3) ----
    // A bare <img> renders every failure identically: a broken icon. The three outcomes an operator
    // most needs to tell apart - the re-link SUCCEEDING (409), the session expiring (401), and
    // Maytapi failing (502) - were pixel-identical, under a caption still promising the code was
    // always live. The success case is the damaging one: a broken icon after a scan that WORKED
    // reads as "that failed", and the next move is to rescan or hand the phone to someone else,
    // which is how a scan lands on the wrong handset.
    {
      const html = renderRelinkQrPage({ senderPhoneId: SENDER, senderStatus: 'qr-screen', expectedNumber: '918882034647' });
      ok(/role="status"/.test(html) && /aria-live="polite"/.test(html),
        'the page has a live status region, so the state is announced rather than inferred from a broken image');
      ok(/onerror/.test(html), 'a failed image load is HANDLED - without onerror every outcome is the same broken icon');
      ok(/fetch\(/.test(html),
        're-fetches the same URL to read the JSON behind the failure (a broken <img> carries no status code)');
      ok(/clearInterval/.test(html), 'there is a path that STOPS the refresh loop - a terminal state exists at all');
      ok(/409/.test(html) && /Re-linked/.test(html),
        'a 409-after-relink renders as success, not as a failure - this is the state that used to look broken');
      ok(/401/.test(html) && /expired/i.test(html), 'a 401 says the session expired rather than showing a broken image');
      ok(/502/.test(html) && /Retrying/i.test(html), 'a 502 says maytapi did not answer and that it is retrying');
      ok(/423/.test(html), 'the wrong-number refusal is a terminal state on the page too, not an endless retry');
      ok(/document\.hidden/.test(html), 'a backgrounded tab stops polling maytapi');
      ok(/deadline/.test(html) && html.includes(String(QR_PAGE_MAX_AGE_MS)),
        `the refresh loop is bounded (${QR_PAGE_MAX_AGE_MS}ms) - an abandoned tab was otherwise two maytapi reads every 10s forever`);
      ok(!/always live/.test(html),
        'the caption no longer claims the code is ALWAYS live - that sentence was false in three of the four states');
      // The page is rendered HTML and the slot id comes off maytapi. JSON.stringify alone does not
      // neutralise '</script>' - the HTML parser sees it before any JS parser does.
      const hostile = renderRelinkQrPage({ senderPhoneId: '</script><script>alert(1)</script>', senderStatus: 'qr-screen' });
      ok(!hostile.includes('<script>alert(1)'), 'a hostile slot id cannot break out of the inline script block');
      ok((hostile.match(/<script>/g) || []).length === 1, 'exactly one script block survives a slot id full of markup');
    }

    // ---- THE PAGE'S BEHAVIOUR, EXECUTED RATHER THAN GREPPED ----
    // The assertions above are string matches on the rendered source, and this PR is the one that
    // learned what those are worth: the auth guard they replaced asserted source ORDER and shipped a
    // live bypass green, because a string match cannot see semantics. So the page script is actually
    // RUN here, against a shim DOM, and the branch that matters is driven end to end. Mutating
    // `stop(...)` to `say(...)` in the success branch leaves every regex above passing and fails
    // these.
    {
      const html = renderRelinkQrPage({ senderPhoneId: SENDER, senderStatus: 'qr-screen', expectedNumber: '918882034647' });
      const source = html.split('<script>')[1].split('</script>')[0];

      // A shim just rich enough for what the page uses. `src` records rather than loads, so the test
      // decides when a load fails and with what - which is the whole point.
      function harness({ reply, hidden = false, clockMs = 0 } = {}) {
        const node = (id) => ({ id, style: {}, textContent: '', hidden: false, src: '', onload: null, onerror: null });
        const el = { qr: node('qr'), st: node('st'), lo: node('lo') };
        const h = { el, cleared: 0, srcSets: [], fetched: [], listeners: {} };
        el.qr.__defineSetter__('src', (v) => { h.srcSets.push(v); });
        el.qr.__defineGetter__('src', () => h.srcSets[h.srcSets.length - 1] || '');
        const doc = {
          getElementById: (id) => el[id],
          get hidden() { return hidden; },
          addEventListener: (n, f) => { h.listeners[n] = f; },
        };
        const fetchStub = (u) => {
          h.fetched.push(u);
          return Promise.resolve({ status: reply.status, json: () => Promise.resolve(reply.body) });
        };
        const FakeDate = { now: () => clockMs };
        const fn = new Function('document', 'fetch', 'setInterval', 'clearInterval', 'Date', source);
        fn(doc, fetchStub, () => 'timer-1', () => { h.cleared += 1; }, FakeDate);
        return h;
      }
      const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

      // SUCCESS: the operator scanned, it worked, the slot flipped active, the fail-closed gate
      // answers 409. This used to render as a broken image under "the code above is always live".
      {
        const h = harness({ reply: { status: 409, body: { status: 'active', number: '+91 88820 34647', phoneId: SENDER } } });
        await h.el.qr.onerror(); await settle();
        ok(h.cleared === 1, 'a successful re-link STOPS the refresh loop - it is a terminal state, not another retry');
        ok(/Re-linked/.test(h.el.st.textContent), 'the status region announces the re-link instead of leaving a broken image');
        ok(h.el.st.textContent.includes('+91 88820 34647'),
          'and NAMES the handset it landed on - the one fact worth confirming right after a scan');
        ok(h.el.qr.style.display === 'none', 'the broken image is hidden rather than left on screen contradicting the text');
      }

      // A 409 that is NOT a re-link (status unreadable, fail-closed) must not claim success.
      {
        const h = harness({ reply: { status: 409, body: { status: 'loading', phoneId: SENDER } } });
        await h.el.qr.onerror(); await settle();
        ok(h.cleared === 0 && !/Re-linked/.test(h.el.st.textContent),
          'a 409 that is not an ACTIVE slot is not announced as a re-link - only a proven one is terminal');
      }

      // SESSION EXPIRY: distinct, terminal, and offers the way back.
      {
        const h = harness({ reply: { status: 401, body: { error: 'Not authenticated.' } } });
        await h.el.qr.onerror(); await settle();
        ok(h.cleared === 1 && /expired/i.test(h.el.st.textContent), 'a 401 is terminal and says the session expired');
        ok(h.el.lo.hidden === false, 'the login link is revealed - the operator is not left with a dead end mid-outage');
      }

      // MAYTAPI FAILURE: explicitly NOT terminal. The slot may still be recoverable on the next pull.
      {
        const h = harness({ reply: { status: 502, body: { error: 'qr fetch http 500' } } });
        await h.el.qr.onerror(); await settle();
        ok(h.cleared === 0, 'a 502 keeps polling - a transient maytapi failure must not end the recovery session');
        ok(/Retrying/i.test(h.el.st.textContent), 'and says so, rather than looking identical to success');
      }

      // The wrong-number refusal is terminal and carries the server's own words.
      {
        const h = harness({ reply: { status: 423, body: { error: `${REBOUND_STATE}. Unlink it first.` } } });
        await h.el.qr.onerror(); await settle();
        ok(h.cleared === 1 && h.el.st.textContent.includes(REBOUND_STATE),
          'a slot bound to an unexpected number is terminal on the page, in the same words as the alert');
      }

      // THE BOUNDS. Both were unbounded before: an abandoned tab issued two maytapi reads every 10s
      // indefinitely, against the account the monitor and the bidder's customer sends share.
      {
        const hidden = harness({ reply: { status: 502, body: {} }, hidden: true });
        ok(hidden.srcSets.length === 0, 'a backgrounded tab pulls nothing at all');
        const live = harness({ reply: { status: 502, body: {} } });
        ok(live.srcSets.length === 1, 'a foreground tab pulls immediately on load');
        ok(typeof live.listeners.visibilitychange === 'function', 'coming back to the tab resumes it');
      }
      {
        // Same script, but the clock is already past the deadline it computed at construction.
        const stale = harness({ reply: { status: 502, body: {} }, clockMs: 0 });
        stale.srcSets.length = 0;
        const fn = new Function('document', 'fetch', 'setInterval', 'clearInterval', 'Date', source);
        const node = (id) => ({ id, style: {}, textContent: '', hidden: false, src: '', onload: null, onerror: null });
        const el = { qr: node('qr'), st: node('st'), lo: node('lo') };
        let cleared = 0; const sets = [];
        el.qr.__defineSetter__('src', (v) => { sets.push(v); });
        let clock = 0;
        fn({ getElementById: (id) => el[id], hidden: false, addEventListener: () => {} },
          () => Promise.resolve({ status: 502, json: () => Promise.resolve({}) }),
          (f) => { el.__tick = f; return 't'; }, () => { cleared += 1; }, { now: () => clock });
        sets.length = 0;
        clock = QR_PAGE_MAX_AGE_MS + 1000;   // the operator wandered off; the tab is still open
        el.__tick();
        ok(sets.length === 0, 'past the bound the page stops pulling from maytapi entirely');
        ok(cleared === 1 && /Stopped refreshing/.test(el.st.textContent),
          'and says it stopped rather than silently showing a stale code forever');
      }
    }

    // ---- THE SUCCESS STATE IS BUILDABLE: the 409 carries the recovered number (r2 Finding 3) ----
    // The page can only say "re-linked, and it is on THIS number" if the refusal it receives after a
    // successful scan actually names the number. It did not before.
    {
      const t = webTransport(BOARD_UP);
      const res = fakeRes();
      await qrHandler({ creds: CREDS_WEB, transport: t })({ query: { img: '1' } }, res);
      ok(res.statusCode === 409 && res.body.number === '+91 88820 34647',
        'the post-relink 409 names the number the slot came back on, so the page can confirm WHICH handset now owns it');
      ok(res.body.status === 'active', 'the 409 carries the status the page branches on');
    }

    // ---- A SERVED PAIRING CREDENTIAL IS AUDITED (r2 Finding 7) ----
    // Every less sensitive privileged action in this app already records actor + ip. Serving the QR
    // - the one action whose abuse is an identity takeover - recorded nothing at all, so after a
    // wrong-number incident there was no on-box evidence of when a QR went out, or to whom.
    //
    // SCOPE OF THIS BLOCK, because it used to overclaim (r1 Finding 7): these are unit tests over a
    // req OBJECT LITERAL, so they can only pin that the handler propagates the fields it is handed
    // and throttles the way it says it does. They CANNOT test what Express resolves req.ip to, and
    // the earlier version of this block hand-supplied ip:'10.0.0.9' and then asserted the record
    // carried '10.0.0.9' - an assertion that cannot fail, and which stayed green while production
    // wrote the constant 127.0.0.1 for want of `trust proxy`. The resolution itself is now pinned by
    // scripts/test-relink-qr-audit-ip.js, which issues a real request through a really-booted app.
    // The sentinel below is deliberately not an IP-shaped string, so nobody can mistake this for
    // that test again.
    {
      const served = [];
      const t = webTransport(BOARD_DOWN);
      let clock = 1000;
      const RESOLVED_IP = 'resolved-by-express-see-test-relink-qr-audit-ip';
      const h = qrHandler({ creds: CREDS_WEB, transport: t, onQrServed: (e) => served.push(e), now: () => clock });
      await h({ query: { img: '1' }, ip: RESOLVED_IP }, fakeRes());
      ok(served.length === 1, 'a successful QR serve writes an audit record');
      ok(served[0].actor === 'ops' && served[0].ip === RESOLVED_IP,
        'the record names the operator and propagates whatever req.ip resolved to (what it resolves TO is pinned in test-relink-qr-audit-ip.js)');
      ok(served[0].phoneId === SENDER && served[0].bytes === PNG.length, 'the record names the slot and how many bytes went out');

      // Throttled, because the page polls - but never silent, and the suppressed count keeps the
      // record honest about how many times the credential was really handed out.
      clock += 5000;
      await h({ query: { img: '1' }, ip: RESOLVED_IP }, fakeRes());
      await h({ query: { img: '1' }, ip: RESOLVED_IP }, fakeRes());
      ok(served.length === 1, 'polling does not write one audit line per 10s tick');
      clock += QR_AUDIT_THROTTLE_MS;
      await h({ query: { img: '1' }, ip: RESOLVED_IP }, fakeRes());
      ok(served.length === 2 && served[1].suppressed === 2,
        'past the throttle the next line lands and reports the polls it stands for - the serve count is never lost');

      // A refusal is not a serve. Auditing a 409 would make the trail useless for the question it
      // exists to answer: was a credential actually handed out.
      const served2 = [];
      await qrHandler({ creds: CREDS_WEB, transport: webTransport(BOARD_UP), onQrServed: (e) => served2.push(e) })({ query: { img: '1' } }, fakeRes());
      ok(served2.length === 0, 'a REFUSED request writes no serve record - the trail means "a QR went out", nothing looser');
    }
  }

  // =========================================================================================
  // ONE COPY OF THE WRONG-HANDSET WARNING (r2 Finding 8).
  //
  // The module header calls a wrong-handset scan "the one mistake that is expensive", and the
  // warning was hand-authored three times - two sentences byte-identical across two files and a
  // third, divergent wording in the monitor. The drift IS the bug: which surface an operator
  // happens to read decided how well they were warned.
  // =========================================================================================
  {
    const GOOD = '918882034647';
    const text = buildScanWarning({ expectedNumber: GOOD, format: 'text' });
    const html = buildScanWarning({ expectedNumber: GOOD, format: 'html' });

    ok(text.handset.includes('+91 88820 34647'), 'the text warning names the handset');
    ok(html.handset.includes('<strong>+91 88820 34647</strong>'), 'the html warning names the handset, marked up for the page');
    ok(text.consequence === html.consequence, 'the consequence sentence is character-identical across channels');
    ok(text.steps === 'On that handset: WhatsApp > Linked Devices > Link a Device.', 'the steps read as plain text off a phone');
    ok(html.steps === 'On that handset: WhatsApp &gt; Linked Devices &gt; Link a Device.', 'the same steps are entity-escaped for HTML');

    // The parity that matters: all three renderers pull from this one source, so a change here
    // reaches every surface at once. Written in the shape of the existing GROUP_JID_RE parity test.
    const caption = buildQrCaption({ senderPhoneId: SENDER, expectedNumber: GOOD, qrUrl: 'https://bids.example.com/api/wa/relink-qr' });
    const page = renderRelinkQrPage({ senderPhoneId: SENDER, senderStatus: 'qr-screen', expectedNumber: GOOD });
    ok(caption.includes(text.handset) && caption.includes(text.consequence) && caption.includes(text.steps),
      'the DM caption is built from the shared fragments, not a hand-copy');
    ok(page.includes(html.handset) && page.includes(html.consequence) && page.includes(html.steps),
      'the on-demand page is built from the same shared fragments');

    // No baseline -> the warning stops naming a handset it cannot name, and says verification is off.
    const blind = buildScanWarning({ expectedNumber: null, format: 'text' });
    ok(!/\+/.test(blind.handset) && /could not be read/.test(blind.handset),
      'with no known number the warning admits it rather than printing a blank or "undefined"');
    ok(buildQrCaption({ senderPhoneId: SENDER, expectedNumber: null }).includes(NO_BASELINE_WARNING),
      'a caption sent with no baseline carries the "rebind verification is OFF" line');
    ok(renderRelinkQrPage({ senderPhoneId: SENDER, senderStatus: 'qr-screen', expectedNumber: null }).includes(NO_BASELINE_WARNING),
      'the page carries the same line, in the same words');
  }

  // =========================================================================================
  // THE MONITOR END TO END: state persistence, the re-bind check, the healthcheck payload.
  // Drives the real main() over a stubbed maytapi + a temp state file.
  // =========================================================================================
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-monitor-'));
    const stateFile = path.join(tmp, 'monitor-wa-state.json');
    // The staff allowlist the "is this number ours" test reads. GOOD (918882034647) is on it and
    // STRANGER is not, which is the whole axis these monitor cases turn on.
    const rosterFile = path.join(tmp, 'staffRoster.json');
    fs.writeFileSync(rosterFile, JSON.stringify({ allowlist: { numbers: ['+918882034647'] } }));
    const HC = 'https://hc.example.test/ping';
    Object.assign(process.env, {
      MONITOR_APP_DIR: tmp,
      MONITOR_STATE_FILE: stateFile,
      SP_STAFF_ROSTER_FILE: rosterFile,
      SP_MAYTAPI_PRODUCT_ID: CREDS.productId,
      SP_MAYTAPI_PHONE_ID: SENDER,
      SP_MAYTAPI_TOKEN: CREDS.token,
      SP_MAYTAPI_ENDPOINT: CREDS.base,
      MONITOR_ALERT_TO: '919000000001',
      MONITOR_COOLDOWN_MIN: '20',
      HEALTHCHECK_URL: HC,
      BREVO_API_KEY: 'brevo-test-key',
      TELEGRAM_BOT_TOKEN: 'tg-test-token',
      TELEGRAM_CHAT_ID: '4242',
      SP_BASE_URL: 'https://bids.example.com',
      // The push tier is OFF by default (unprobed send leg). These end-to-end cases are about what
      // happens once an operator has probed and enabled it, so it is turned on explicitly here -
      // which is also the point: it takes a deliberate act, and the knob-off case below proves the
      // deploy-time default sends nothing.
      SP_WA_QR_IN_ALERT: '1',
    });
    delete process.env.SP_MAYTAPI_SENDER_NUMBER;
    delete process.env.MONITOR_ALERT_VIA_PHONE;
    const { main, buildDownAlert } = require('./monitor-wa-sender');

    function monitorFetch(board) {
      const fn = async (url, opts) => {
        const u = String(url);
        fn.calls.push(u);
        // Telegram's URL also ends in /sendMessage, so the host-specific tiers are matched FIRST -
        // otherwise a telegram alert would be counted as a WhatsApp one and the per-tier assertions
        // below would be testing the wrong thing.
        if (u.startsWith('https://api.brevo.com')) { fn.email.push(JSON.parse(opts.body)); return { ok: true, status: 201, json: async () => ({}) }; }
        if (u.startsWith('https://api.telegram.org')) { fn.telegram.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({}) }; }
        if (u === HC) { fn.pings.push(String(opts && opts.body)); return { ok: true, status: 200, json: async () => ({}) }; }
        if (/listPhones$/.test(u)) return { ok: true, status: 200, json: async () => ({ data: board }) };
        if (/\/qrCode$/.test(u)) return { ok: true, status: 200, arrayBuffer: async () => PNG };
        if (/sendMessage$/.test(u)) { fn.wa.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm1' } }) }; }
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      };
      fn.calls = []; fn.wa = []; fn.email = []; fn.telegram = []; fn.pings = [];
      return fn;
    }
    const realFetch = globalThis.fetch;
    const runMonitor = async (board, seedState) => {
      if (seedState === null) { try { fs.unlinkSync(stateFile); } catch (_) { /* absent */ } }
      else fs.writeFileSync(stateFile, JSON.stringify(seedState));
      const t = monitorFetch(board);
      globalThis.fetch = t;
      let r;
      try { r = await main(); } finally { globalThis.fetch = realFetch; }
      return { t, result: r, state: JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
    };
    const UP = (number) => [{ id: 128023, number, status: 'active' }, { id: 136151, number: '919594964196', status: 'active' }];
    const DOWN = [{ id: 128023, number: null, status: 'qr-screen' }, { id: 136151, number: '919594964196', status: 'active' }];
    const GOOD = '918882034647';
    const STRANGER = '919999999999';

    // ---- a healthy run RECORDS the number; this is what everything else depends on ----
    {
      const { t, result, state } = await runMonitor(UP(GOOD), null);
      ok(state.lastKnownNumber === GOOD, 'a healthy run persists the sender MSISDN into the state file (the down state cannot supply it)');
      ok(state.healthy === true && state.alerted === false, 'a healthy first run is otherwise unchanged');
      ok(result.action === 'none', 'a healthy first run with no prior alert announces nothing');
      ok(t.wa.length === 0 && t.email.length === 0, 'a first healthy read raises no alert on any tier');
      ok(t.pings.length === 1 && / qr=none /.test(t.pings[0]), 'the healthcheck ping carries the QR outcome field even when the QR tier never ran');
      // the web app reads the same file to name the handset on the on-demand page
      ok(readLastKnownNumber(stateFile, {}) === GOOD, 'the app can read the persisted number out of the monitor state file for the QR page');
      ok(readLastKnownNumber(path.join(tmp, 'nope.json'), {}) === null, 'a missing state file is null, never a throw and never a guess');
      ok(readLastKnownNumber(path.join(tmp, 'nope.json'), { SP_MAYTAPI_SENDER_NUMBER: '911111111111' }) === null,
        'and a leftover SP_MAYTAPI_SENDER_NUMBER cannot name it either - the pin is gone, not merely deprioritised');
    }

    // ---- recovery on the SAME number is a real recovery ----
    {
      const { t, result, state } = await runMonitor(UP(GOOD), { healthy: false, alerted: true, downSince: new Date(Date.now() - 3600e3).toISOString(), lastAlertAt: new Date(Date.now() - 3600e3).toISOString(), lastKnownNumber: GOOD });
      ok(result.action === 'alert-recovered', 'the slot coming back on OUR number is announced as a recovery');
      ok(t.wa.some((m) => /working again/.test(m.message)), 'the recovery alert still goes out on the WA tier');
      ok(state.healthy === true && state.lastKnownNumber === GOOD, 'the recovered number is re-recorded');
    }

    // ---- recovery on a DIFFERENT number is NOT a recovery. This is the money assertion. ----
    {
      const { t, result, state } = await runMonitor(UP(STRANGER), { healthy: false, alerted: true, downSince: new Date(Date.now() - 3600e3).toISOString(), lastAlertAt: new Date(Date.now() - 3600e3).toISOString(), lastKnownNumber: GOOD });
      ok(result.action === 'alert-wrong-number', 'a slot that came back on a DIFFERENT account is its own state, not recovery');
      ok(!t.wa.some((m) => /is BACK/.test(m.message)) && !t.email.some((m) => /is BACK/.test(m.subject)),
        'NOTHING says "is BACK" - a wrong re-bind must never read as delivery restored');
      const loud = new RegExp(REBOUND_STATE);
      ok(t.wa.some((m) => loud.test(m.message)), 'the wrong-number alert fires on the WhatsApp sibling tier');
      ok(t.email.some((m) => loud.test(m.subject)), 'the wrong-number alert fires on the maytapi-independent email tier');
      ok(t.telegram.some((m) => loud.test(m.text)), 'the wrong-number alert fires on the telegram tier - all tiers, not just one');
      const wa = t.wa.find((m) => loud.test(m.message)).message;
      ok(wa.includes('+91 99999 99999') && wa.includes('+91 88820 34647'),
        'the alert names BOTH the number it is wrongly on and the one it should be on');
      ok(/UNLINK/i.test(wa), 'the alert tells the operator the one action that stops it');
      ok(state.lastKnownNumber === GOOD, 'the WRONG number is never adopted as the new expected - otherwise this alert silences itself next run');
      ok(state.reboundTo === STRANGER && state.healthy === false, 'the wrong binding is recorded and the slot is not counted healthy');
      ok(t.pings.length === 1 && /action=alert-wrong-number/.test(t.pings[0]), 'the healthcheck ping carries the wrong-number action');
    }

    // ---- the same wrong number does not re-alert every 2 minutes; it rides the cooldown ----
    {
      const { result } = await runMonitor(UP(STRANGER), { healthy: false, alerted: true, downSince: new Date(Date.now() - 3600e3).toISOString(), lastAlertAt: new Date().toISOString(), lastKnownNumber: GOOD, reboundTo: STRANGER });
      ok(result.action === 'wrong-number-cooldown', 'an already-reported wrong number waits for the cooldown rather than spamming every cron tick');
    }

    // ---- first-ever healthy read with nothing to compare against records and continues ----
    //
    // THIS IS THE REAL POST-DEPLOY SHAPE (r2 Findings 4 + 5). `lastKnownNumber` is a new field, so
    // no state file in existence has it, and it is only written on a HEALTHY run - which means the
    // window in which verification is impossible is exactly the first re-link after this build
    // ships. The seeded-good-baseline case above does not cover it. What used to happen here: the
    // monitor announced "OK: sender is BACK ... active again on the expected number" over a number
    // it had never seen before and could not verify, and adopted it as the permanent baseline in
    // silence. If that re-link was scanned on the wrong handset, a takeover was announced as a
    // recovery and the alarm could never fire for it again.
    {
      const { t, result, state } = await runMonitor(UP(STRANGER), { healthy: false, alerted: true, downSince: new Date(Date.now() - 3600e3).toISOString(), lastAlertAt: new Date(Date.now() - 3600e3).toISOString() });
      ok(result.action === 'alert-recovered' && state.lastKnownNumber === STRANGER,
        'with no persisted number there is nothing to verify against - record it and carry on, never block a cold start');
      ok(!t.wa.some((m) => /is BACK/.test(m.message)) && !t.email.some((m) => /is BACK/.test(m.subject)),
        'an UNVERIFIABLE recovery is never announced as "is BACK" - that sentence asserts the one thing this run cannot know');
      ok(!t.email.some((m) => /on the expected number/.test(m.textContent)),
        'nothing claims the slot came back "on the expected number" when there was no expected number');
      const unver = /cannot check/;
      ok(t.email.some((m) => unver.test(m.subject)), 'the email tier says plainly that the number is unverified');
      ok(t.wa.some((m) => unver.test(m.message)), 'the WhatsApp tier says it too');
      ok(t.telegram.some((m) => unver.test(m.text)), 'and the telegram tier - every tier, not just one');
      const body = t.email.find((m) => unver.test(m.subject)).textContent;
      ok(body.includes('+91 99999 99999'), 'the alert NAMES the number it just adopted, so the operator can check it against the handset');
      ok(/Please check whose phone it is/.test(body) && /staff list/.test(body),
        'it asks for confirmation and names the list that closes the window for good');
      ok(!/SP_MAYTAPI_SENDER_NUMBER|\.env/.test(body),
        'and it never tells anyone to go and edit .env - the pin is gone, the staff list is the remedy now');
    }

    // ---- an unverified baseline keeps being reported until it is confirmed ----
    // Adopting blind is survivable; forgetting that you adopted blind is not. A wrong baseline does
    // not merely disable the alarm, it INVERTS it - the next genuinely correct re-link then alerts
    // naming BRL's own number as the intruder. So the state has to keep being said out loud.
    //
    // WHERE it is said moved. It used to be a paragraph on every alert tier, and it was the longest
    // thing in a message an operator reads on a phone mid-outage while the only remedy is an .env
    // edit they cannot make from there. It now rides the healthcheck ping and the run log - the
    // monitor's developer-facing surfaces - and these assertions moved with it rather than being
    // dropped. The operator-facing half is unaffected: the re-link page and the QR caption still
    // carry NO_BASELINE_WARNING at the moment of the scan (asserted above and below).
    {
      const seed = { healthy: false, alerted: false, downSince: new Date(Date.now() - 3600e3).toISOString(), lastKnownNumber: STRANGER };
      const { t, state } = await runMonitor(DOWN, seed);
      const nag = /SP_MAYTAPI_SENDER_NUMBER|\.env/;
      // POSITIVE FIRST, then the absence. An all-negative block is satisfied by EMPTY tier arrays,
      // so a regression that stopped the monitor sending anything at all would pass it green - the
      // predecessor assertions were `some(...)` checks and could not. Prove the alert went out on
      // each tier, then prove the config paragraph is not in it.
      const sent = { email: t.email.filter((m) => /stopped sending/i.test(m.subject)), wa: t.wa.filter((m) => m.type !== 'image'), tg: t.telegram };
      ok(sent.email.length > 0 && sent.wa.length > 0 && sent.tg.length > 0,
        'the down alert actually went out on all three tiers');
      ok(!sent.email.some((m) => nag.test(m.textContent)) && !sent.wa.some((m) => nag.test(m.message)) && !sent.tg.some((m) => nag.test(m.text)),
        'and no longer spends a paragraph of the operator alert on a config fact they cannot act on');
      ok(state.lastKnownNumber === STRANGER,
        'the observation survives the down state - it is the only thing that can name the handset while the board reports number:null');
      ok(t.pings.some((p) => p.includes('baseline=ok')),
        'and the ping reports a baseline is on record, which is now the whole of what that field says');
    }

    // ---- A RECOVERY ONTO A NUMBER BRL IS NOT KNOWN TO HOLD IS HEDGED ----
    // The '❓ cannot check' subject fires only on a 'first-run', which needs expectedNumber to be
    // null - so it fires ONCE, on the run that adopts a number. From then on the slot is comparing
    // against itself: classifyRebind returns 'match' and the ordinary green branch runs. If that
    // branch says nothing, every recovery after the first reads as verified when nothing verified
    // it, on the exact path the re-bind check exists for - a slot that came back on a stranger's
    // phone looks identical to one that came back on BRL's.
    {
      const seed = {
        healthy: false, alerted: true,
        downSince: new Date(Date.now() - 3600e3).toISOString(), lastAlertAt: new Date(Date.now() - 3600e3).toISOString(),
        lastKnownNumber: STRANGER,
      };
      const { t, result } = await runMonitor(UP(STRANGER), seed);
      ok(result.action === 'alert-recovered', 'a re-link back onto the same number is a recovery, not an alarm');
      const em = t.email.find((m) => /working again/.test(m.subject));
      ok(em, 'it is announced as a recovery');
      const hedge = /is not on BRL's list/;
      ok(hedge.test(em.textContent) && em.textContent.includes(displayMsisdn(STRANGER)),
        'and it says the number is not one BRL is known to hold, naming it');
      ok(!/SP_MAYTAPI_SENDER_NUMBER|[.]env/.test(em.textContent),
        'without sending anyone to edit .env - the staff list is the remedy now, and it is not an outage-time job');
      ok(t.wa.some((m) => m.type !== 'image' && hedge.test(m.message)) && t.telegram.some((m) => hedge.test(m.text)),
        'on every tier, not just email');

      // ...and the mirror case, which is what stops the hedge becoming wallpaper: a recovery onto a
      // number BRL IS known to hold carries no hedge at all.
      const clean = await runMonitor(UP(GOOD), Object.assign({}, seed, { lastKnownNumber: GOOD }));
      const cem = clean.t.email.find((m) => /working again/.test(m.subject));
      ok(cem && !hedge.test(cem.textContent),
        'a recovery onto a number on BRL own list is announced plainly, with nothing to check');
    }

    // =======================================================================================
    // MEMBERSHIP IS THE AUTHORITY. The cases below are the whole contract, and they replace the
    // block that pinned SP_MAYTAPI_SENDER_NUMBER's precedence.
    //
    // WHY THE PIN WENT. It declared one owning MSISDN and outranked the observation, so the ONLY
    // question the alarm could ask was "is this THE number". BRL runs several handsets on one
    // Maytapi product and moves the sender between them, which makes that question wrong rather
    // than merely strict: every legitimate swap is an alarm, and the only remedy is to go and
    // re-type the declaration. On 2026-09-22 the slot was re-linked back to BRL's own original
    // handset while the pin still held the number used during the previous week's outage. The
    // result was 35 hours of urgent alarms on three tiers, every 30 minutes, naming BRL's own
    // handset as the intruder and telling someone to unlink the one working phone.
    //
    // The question that separates a swap from a capture is "is this ONE OF OURS", and it is
    // answerable from data the system already has - the Maytapi board and the staff allowlist -
    // rather than from a value a human has to keep in sync by hand.
    // =======================================================================================
    {
      const downAlerted = () => ({
        healthy: false, alerted: true,
        downSince: new Date(Date.now() - 3600e3).toISOString(), lastAlertAt: new Date(Date.now() - 3600e3).toISOString(),
      });

      // ---- 1. it moved to one of BRL's own numbers -> a quiet notice, and it is ADOPTED ----
      // GOOD is on the staff roster the harness wrote; the slot was last seen on the fallback's
      // number. This is the 2026-09-22 shape exactly.
      {
        const seed = Object.assign(downAlerted(), { lastKnownNumber: '919594964196' });
        const { t, result, state } = await runMonitor(UP(GOOD), seed);
        ok(result.action === 'notice-fleet-rebind',
          'a move to a number BRL is known to hold is a NOTICE, not the wrong-number alarm');
        ok(!t.email.some((m) => new RegExp(REBOUND_STATE).test(m.subject)),
          'the urgent alarm does not fire on any tier');
        const em = t.email.find((m) => /sending from a different number/.test(m.subject));
        ok(em && em.textContent.includes('+91 88820 34647') && em.textContent.includes('+91 95949 64196'),
          'the notice names both the new number and the one it replaced');
        ok(/Both phones are BRL/.test(em.textContent) && /No action needed/.test(em.textContent),
          'and says plainly that nothing is wrong, in words a director reads without decoding');
        ok(t.wa.filter((m) => m.type !== 'image').length === 0 && t.telegram.length === 0,
          'EMAIL ONLY - waking the WhatsApp and Telegram tiers for a routine swap is the noise this branch exists to stop');
        ok(state.lastKnownNumber === GOOD && state.healthy === true,
          'the new number is adopted, which is what makes this said ONCE rather than every cooldown');
        ok(state.reboundTo == null, 'and no rebound is left standing against the slot');
      }

      // ---- 2. said once: the very next run is silent ----
      {
        const seed = Object.assign(downAlerted(), { lastKnownNumber: '919594964196' });
        const first = await runMonitor(UP(GOOD), seed);
        const second = await runMonitor(UP(GOOD), first.state);
        ok(second.result.action === 'none' && second.t.email.length === 0,
          'the run after a fleet notice says nothing at all - this is the fix for 35 hours of repeats');
      }

      // ---- 3. it moved to a number that is NOT ours -> the alarm, and it is NOT adopted ----
      {
        const seed = Object.assign(downAlerted(), { lastKnownNumber: GOOD });
        const { t, result, state } = await runMonitor(UP(STRANGER), seed);
        ok(result.action === 'alert-wrong-number',
          'a move to a number on neither the board nor the staff list still raises the full alarm');
        ok(!t.wa.some((m) => /working again/.test(m.message)) && !t.email.some((m) => /working again/.test(m.subject)),
          'nothing says the bidder is working again for a slot bound to the wrong account');
        const wa = t.wa.find((m) => new RegExp(REBOUND_STATE).test(m.message)).message;
        ok(wa.includes('+91 99999 99999') && wa.includes('+91 88820 34647'),
          'the alert names both the intruder and the number it should be on');
        ok(/add it to the staff list/.test(wa),
          'and offers the cheap remedy first, because a new BRL phone nobody has listed looks exactly like a stranger from here');
        ok(state.lastKnownNumber === GOOD && state.reboundTo === STRANGER,
          'THE STRANGER IS NEVER ADOPTED - adopting it would silence the alarm on the very next run, which is the one failure this check exists to prevent');
      }

      // ---- 4. and it keeps alarming, because nothing adopted it ----
      {
        const seed = Object.assign(downAlerted(), { lastKnownNumber: GOOD });
        const first = await runMonitor(UP(STRANGER), seed);
        const second = await runMonitor(UP(STRANGER), first.state);
        ok(second.result.action === 'wrong-number-cooldown',
          'the second run still holds the slot in the wrong-number state - quieted by the cooldown, never resolved by adoption');
      }

      // ---- 5. a cold start never alarms, but says what it could not check ----
      {
        const { t, result, state } = await runMonitor(UP(STRANGER), downAlerted());
        ok(result.action === 'alert-recovered',
          'a cold start never alarms - refusing to acknowledge a healthy sender for want of history would be a permanent false alarm');
        ok(state.lastKnownNumber === STRANGER, 'the number is recorded');
        ok(t.email.some((m) => /cannot check/.test(m.subject)),
          'and the alert says plainly that nothing here could confirm the phone is BRL’s');
      }

      // ---- 6. a cold start onto a number that IS ours is announced plainly ----
      {
        const { t, result } = await runMonitor(UP(GOOD), downAlerted());
        ok(result.action === 'alert-recovered', 'still a recovery');
        ok(!t.email.some((m) => /cannot check/.test(m.subject)),
          'but with no "cannot check" hedge, because the roster answers the question the history could not');
      }

      // ---- the observation record only ever holds what a healthy run saw ----
      {
        const { state } = await runMonitor(DOWN, { healthy: false, alerted: false, downSince: new Date(Date.now() - 3600e3).toISOString() });
        ok(state.lastKnownNumber == null,
          'a DOWN run on a box that has never seen the slot healthy records NO observation rather than inventing one');
      }
      {
        const { state } = await runMonitor(DOWN, { healthy: false, alerted: false, downSince: new Date(Date.now() - 3600e3).toISOString(), lastKnownNumber: STRANGER });
        ok(state.lastKnownNumber === STRANGER,
          'and a down run carries the real observation forward unchanged - it is the only thing that can name the handset while the board reports number:null');
      }
    }

    // ---- with NO baseline at all, the missing wrong-handset alarm is still reported (r2 Finding 4) ----
    // This is the window the pin exists to close. It reaches two audiences, and they need different
    // things: whoever is about to SCAN needs to know verification is off before they scan, and gets
    // it on the surface they are looking at while doing it; whoever can FIX it needs the .env name,
    // and gets it off-box where a config defect is visible without reading cron stdout.
    {
      const { t } = await runMonitor(DOWN, { healthy: false, alerted: false, downSince: new Date(Date.now() - 3600e3).toISOString() });
      const off = /wrong-phone check is OFF/;
      ok(t.pings.some((p) => p.includes('baseline=none')),
        'the run reports off-box that there is no baseline, so the alarm being disarmed is visible without reading cron stdout');
      const img = t.wa.find((m) => m.type === 'image');
      ok(img && off.test(img.text),
        'and the QR caption still carries the warning in full - that is the surface someone is looking at while scanning');
      // The alert BODY in this exact state, not just the ping and the caption. The pointer must not
      // claim the page names a handset when there is no baseline for it to name.
      const body = t.email.find((m) => /stopped sending/i.test(m.subject)).textContent;
      ok(!/handset the page names/.test(body) && /cannot name the handset/.test(body),
        'and the alert body admits the page cannot name a handset rather than pointing at a name that is not there');
    }

    // ---- the down-alert is short enough to be read on a phone, and still says the three things ----
    // Length was the defect. The reader is an operator holding a phone mid-outage who needs to know
    // that something is broken, whether it is urgent, and what to do; everything else displaced one
    // of those three. The budget is asserted, not just the content, because copy grows back.
    {
      const { t } = await runMonitor(DOWN, { healthy: false, alerted: false, downSince: new Date(Date.now() - 12 * 60e3).toISOString(), lastKnownNumber: GOOD });
      const m = t.email.find((e) => /stopped sending/i.test(e.subject));
      const msg = `${m.subject}\n\n${m.textContent}`;
      const lines = msg.split('\n').filter((l) => l.trim());
      ok(lines.length <= 6, `the whole alert is at most 6 non-blank lines (got ${lines.length})`);

      ok(/Bidding is still running normally/.test(msg),
        'it says bidding is unaffected - the difference between an emergency and a chore, and the fact most likely to be acted on wrongly');
      ok(/Maytapi slot 128023/.test(msg) && /down 12m/.test(msg), 'what is broken and for how long');
      ok(/https:\/\/bids\.example\.com\/api\/wa\/relink-qr/.test(msg), 'and the link, which is the action');
      ok(/handset the page names/.test(msg),
        'it points at the wrong-handset warning rather than restating it - the page renders it above the QR, where the scan actually happens');
      ok(/login twice/.test(msg),
        'the two-credential-prompts clause survives the trim: an unexpected browser popup mid-outage reads as a broken link');

      ok(!/occasional reminder|not repeats|repeated alert/.test(msg),
        'no commentary about how often the alerting system will fire - that is the alert talking about itself');
      ok(!/SP_MAYTAPI_SENDER_NUMBER|\.env/.test(msg),
        'no developer configuration note - it names a file the reader cannot edit from a phone');
      ok(!/maytapi\.com/.test(msg),
        'no console fallback while an in-app page exists - a second route offered before the first has been tried; it lives in docs/NOTIFICATIONS.md');

      // Strict equality, not a line count. The two are byte-identical at HEAD, so the weaker form
      // bought nothing and would have stayed green on a WhatsApp-only reword of equal line count -
      // which is exactly the per-tier divergence this assertion claims to rule out.
      const wa = t.wa.find((x) => x.type !== 'image');
      ok(wa && wa.message === msg,
        'and the WhatsApp tier gets the same message, not a differently-trimmed one');
    }

    // ---- with no in-app page to point at, the alert carries the warning itself ----
    // The trim above is only safe because the destination page renders the wrong-handset warning
    // above the QR. On a box with no SP_BASE_URL there is no destination, so the short pointer would
    // point at nothing - that branch says it in full and names the console instead. Asserted end to
    // end here (the env var really does reach relinkQrUrl); the four-state matrix is below.
    {
      const base = process.env.SP_BASE_URL;
      delete process.env.SP_BASE_URL;
      let t;
      try { ({ t } = await runMonitor(DOWN, { healthy: false, alerted: false, downSince: new Date(Date.now() - 12 * 60e3).toISOString(), lastKnownNumber: GOOD })); }
      finally { process.env.SP_BASE_URL = base; }
      const msg = t.email.find((e) => /stopped sending/i.test(e.subject)).textContent;
      ok(msg.includes(displayMsisdn(GOOD)) && /from any other phone/.test(msg),
        'with no page to carry it, the full wrong-handset warning stays in the alert');
      ok(/console\.maytapi\.com/.test(msg), 'and the console is named, because it is the only route left');
    }

    // ---- the down-alert across all four states, off the pure builder ----
    // Two of these four are unreachable through main(): `allTiersDown` means NO delivery tier is
    // configured, so a harness that could trigger it could not capture anything, and before
    // buildDownAlert() was extracted the 🔴 body was rendered by no test at all. The states differ
    // on two axes - is there a page to point at, is there a handset name to point at - and both
    // "no" answers are the ones a pointer-shaped message gets wrong.
    {
      const withName = buildScanWarning({ expectedNumber: GOOD, format: 'text' });
      const noName = buildScanWarning({ expectedNumber: null, format: 'text' });
      const URL = 'https://bids.example.com/api/wa/relink-qr';
      const common = { senderId: SENDER, statusStr: 'loading', downMin: 12, downSince: new Date().toISOString() };
      const nonBlank = (s) => s.split('\n').filter((l) => l.trim()).length;

      // 1. page + a known handset - the production shape, and the one the budget applies to.
      const a = buildDownAlert(Object.assign({}, common, { allTiersDown: false, relinkUrl: URL, warn: withName, hasBaseline: true }));
      ok(/handset the page names/.test(a.body), 'with a page and a name, the alert points at the page');

      // 2. page + NO known handset. The page cannot name a handset in this state (buildScanWarning
      //    returns "its number could not be read"), so promising one sends the reader looking for
      //    something that is not there.
      const b = buildDownAlert(Object.assign({}, common, { allTiersDown: false, relinkUrl: URL, warn: noName, hasBaseline: false }));
      ok(!/handset the page names/.test(b.body) && /cannot name the handset/.test(b.body),
        'with no baseline the alert does not promise a name the page cannot supply');
      ok(b.body.includes(URL), 'it still carries the link, which is still the action');

      // 3. no page + a known handset. Nothing downstream exists, so the alert says it all.
      const c = buildDownAlert(Object.assign({}, common, { allTiersDown: true, relinkUrl: null, warn: withName, hasBaseline: true }));
      ok(c.body.includes(withName.handset) && c.body.includes(withName.consequence) && c.body.includes(withName.steps),
        'with no page the alert carries all three warning fragments, steps included');
      ok(/console\.maytapi\.com/.test(c.body), 'and names the console, the only route left');

      // 4. no page + no handset. NO_BASELINE_WARNING has no other carrier here at all: no page, and
      //    the QR image push is off by default. Dropping it would leave the operator scanning with
      //    nothing anywhere saying the wrong-handset alarm cannot fire.
      const d2 = buildDownAlert(Object.assign({}, common, { allTiersDown: true, relinkUrl: null, warn: noName, hasBaseline: false }));
      ok(d2.body.includes(NO_BASELINE_WARNING),
        'with neither a page nor a baseline, the alert is the only carrier for "rebind verification is OFF" and carries it');

      // The emergency branch is a different message, not a longer one, and it is still budgeted.
      const em = buildDownAlert(Object.assign({}, common, { allTiersDown: true, relinkUrl: URL, warn: withName, hasBaseline: true }));
      ok(/🔴/.test(em.subject) && /🟡/.test(a.subject), 'the two urgencies are distinguishable at a glance');
      ok(/Bidding is still running normally/.test(em.body),
        'the emergency alert still leads with the system state - "sender is DOWN" alone reads as the BIDDER being down');
      ok(nonBlank(`${em.subject}\n\n${em.body}`) <= 6,
        `the emergency alert is budgeted too, not just the quiet one (got ${nonBlank(`${em.subject}\n\n${em.body}`)})`);
      ok(!/SP_MAYTAPI_SENDER_NUMBER/.test(em.body) && !/occasional reminder/.test(em.body),
        'and carries neither the config note nor the cadence commentary');
    }

    // ---- the state file is written atomically (r2 Finding 5) ----
    // This file now holds a security-control baseline AND is read ~6x/min by the app's QR page while
    // it is open. A truncate-then-write leaves a window where a reader sees garbage and a crash
    // leaves the baseline silently erased.
    {
      const { state } = await runMonitor(UP(GOOD), { healthy: false, alerted: true, downSince: new Date(Date.now() - 3600e3).toISOString(), lastAlertAt: new Date(Date.now() - 3600e3).toISOString(), lastKnownNumber: GOOD });
      ok(state.lastKnownNumber === GOOD, 'the state still lands on disk');
      ok(!fs.existsSync(`${stateFile}.tmp`), 'the temp file is renamed over the real one, never left behind');
      ok(readLastKnownNumber(stateFile, {}) === GOOD, 'and the app can read the renamed file straight after');
    }

    // ---- a corrupt state file is a loud reset, not a silent one ----
    // Truncated JSON used to be swallowed by `catch (_) {}`, silently re-opening the unverified
    // window on a box that had already closed it.
    {
      fs.writeFileSync(stateFile, '{"lastKnownNumber":"9188820346');   // truncated mid-write
      const t = monitorFetch(UP(GOOD));
      const realFetch2 = globalThis.fetch;
      globalThis.fetch = t;
      let threw = false;
      try { await main(); } catch (_) { threw = true; } finally { globalThis.fetch = realFetch2; }
      ok(!threw, 'an unparseable state file does not crash the monitor - alerting must survive it');
      ok(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastKnownNumber === GOOD, 'the run recovers and re-records the number it observed');
    }

    // ---- the down alert: QR delivered, caption names the handset, outcome on the ping ----
    {
      const { t, result, state } = await runMonitor(DOWN, { healthy: false, alerted: false, downSince: new Date(Date.now() - 3600e3).toISOString(), lastKnownNumber: GOOD });
      ok(result.action === 'alert-down', 'a sender down past the grace window alerts');
      const img = t.wa.find((m) => m.type === 'image');
      ok(!!img, 'the QR image is delivered alongside the text alert');
      ok(img.text.includes('+91 88820 34647'),
        'the caption names the handset using the number persisted while the slot was healthy - the live board reports number:null here');
      ok(img.text.includes('https://bids.example.com/api/wa/relink-qr'), 'the caption carries the on-demand page URL built from SP_BASE_URL');
      const txt = t.wa.find((m) => m.type === 'text');
      ok(txt.message.includes('https://bids.example.com/api/wa/relink-qr'), 'the DOWN alert TEXT carries the live-QR URL - that is the primary path, not the image');
      // The warning moved to where the scan happens rather than being deleted. The alert points at
      // it in one clause; the page renders it above the QR and the caption carries it on the image,
      // both off the same buildScanWarning() source (asserted in the parity block above). Restating
      // it here as well is what taught the reader to skim the red block as already-read.
      ok(/handset the page names/.test(txt.message) && !/any other phone/i.test(txt.message),
        'the alert points at the wrong-handset warning; the page and the caption are where it is said in full');
      ok(img.text.includes('+91 88820 34647') && /any other phone/i.test(img.text),
        'and the QR caption still names the handset and spells out what a wrong scan does');
      ok(!/console\.maytapi\.com/.test(txt.message),
        'the console fallback is not offered before the in-app page has been tried - it is the runbook step for app-down-too (docs/NOTIFICATIONS.md)');
      ok(state.lastKnownNumber === GOOD, 'the last-known-good number survives the down state (it is only recorded while healthy)');
      ok(t.pings.length === 1 && / qr=sent /.test(t.pings[0]), 'the healthcheck ping reports the QR tier actually delivered');
    }

    // ---- a dark QR tier is visible on the ping rather than only in unread cron stdout ----
    {
      process.env.SP_WA_QR_IN_ALERT = 'off';
      const { t } = await runMonitor(DOWN, { healthy: false, alerted: false, downSince: new Date(Date.now() - 3600e3).toISOString(), lastKnownNumber: GOOD });
      delete process.env.SP_WA_QR_IN_ALERT;
      ok(/ qr=skipped /.test(t.pings[0]), 'the knob-off QR tier reports qr=skipped on the healthcheck ping');
      ok(!t.wa.some((m) => m.type === 'image'), 'knob off still means no image on the wire');
    }

    ok(qrOutcome(null) === 'none' && qrOutcome({ attempted: false }) === 'skipped'
      && qrOutcome({ attempted: true, sent: 2 }) === 'sent' && qrOutcome({ attempted: true, sent: 0, failed: 2 }) === 'failed',
      'the healthcheck outcome word distinguishes never-ran / skipped / delivered / failed');

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }

  // =========================================================================================
  // THE BURST CADENCE: a ~20s credential pushed on a 30-minute cooldown is dead on arrival.
  //
  // decideQrBurst() is the resolution: each full down-alert opens a short window in which a
  // freshly-fetched QR is re-pushed, bounded by BOTH a time window and a hard count. These pin the
  // bounds, because "keeps sending pairing credentials" is the one failure this must not have.
  // =========================================================================================
  {
    const cfg = { qrRefreshMs: 2 * 60000, qrBurstMs: 20 * 60000, qrBurstMax: 6 };
    const T0 = Date.parse('2026-07-25T10:00:00.000Z');
    const at = (min) => ({ nowMs: T0 + min * 60000, nowIso: new Date(T0 + min * 60000).toISOString() });
    const burst = (min, action, qrState, senderDown = true) =>
      decideQrBurst(Object.assign({ senderDown, action, state: { qr: qrState }, cfg }, at(min)));

    // A full alert opens the window and pushes with it.
    const first = burst(0, 'alert-down', {});
    ok(first.send === true && first.state.sends === 1, 'the first down-alert pushes a QR and opens the burst window');

    // Between alerts the burst keeps a live code arriving, but only past the refresh interval.
    ok(burst(1, 'down-cooldown', first.state).send === false, 'inside the refresh interval nothing is pushed (no per-tick spam)');
    const second = burst(3, 'down-cooldown', first.state);
    ok(second.send === true && second.state.sends === 2, 'past the refresh interval the burst pushes a FRESH code, so a late reader still gets a live one');
    ok(second.state.burstFrom === first.state.burstFrom, 'a burst refresh does not restart the window - the bound is anchored on the alert');

    // TIME bound.
    ok(burst(25, 'down-cooldown', first.state).send === false, 'past the burst window nothing is pushed, however long the outage runs');
    ok(/window closed/.test(burst(25, 'down-cooldown', first.state).reason), 'the closed window is reported as the reason');

    // COUNT bound - the belt to the time brace. A mangled/future timestamp must not defeat both.
    const spent = { burstFrom: new Date(T0).toISOString(), lastSentAt: new Date(T0).toISOString(), sends: 6 };
    ok(burst(10, 'down-cooldown', spent).send === false, 'the hard per-burst cap stops pushes even inside the time window');
    ok(/cap 6/.test(burst(10, 'down-cooldown', spent).reason), 'the cap is named in the reason');
    const garbled = { burstFrom: 'not-a-date', lastSentAt: 'not-a-date', sends: 0 };
    ok(burst(1, 'down-cooldown', garbled).send === false, 'an unparseable burst timestamp fails CLOSED - it never becomes an unbounded loop');

    // A later full re-alert re-opens the window with a fresh budget (the operator is being told
    // again, so a live code alongside it is useful again).
    const reopened = burst(400, 'alert-still-down', spent);
    ok(reopened.send === true && reopened.state.sends === 1, 'a later full re-alert re-opens the burst with a fresh budget');

    // Recovery closes it, and a stale window never leaks into the next outage.
    const closed = decideQrBurst(Object.assign({ senderDown: false, action: 'alert-recovered', state: { qr: first.state }, cfg }, at(5)));
    ok(closed.send === false && Object.keys(closed.state).length === 0, 'recovery clears the burst state - the next outage starts with a full budget');
    ok(burst(1, 'pending-grace', {}).send === false, 'inside the grace window, before any alert has fired, nothing is pushed');
  }

  // =========================================================================================
  // The pre-enable probe exists and is inert on import. It is the ONE thing a mocked transport
  // cannot substitute for (does a real ~6 KB QR still SCAN after WhatsApp re-encodes it), so it is
  // pinned here as a required artifact rather than left as a note in a review.
  // =========================================================================================
  {
    const probePath = path.join(__dirname, 'probe-sender-qr.js');
    ok(fs.existsSync(probePath), 'scripts/probe-sender-qr.js exists - the send leg has a real verification path');
    const probe = require('./probe-sender-qr');           // must not fire anything on import
    ok(typeof probe.parseArgs === 'function', 'the probe is importable without executing a run (require.main guard)');
    const a = probe.parseArgs(['--slot', '126187', '--to', '919356252711', '--via', '136151']);
    ok(a.slot === '126187' && a.to === '919356252711' && a.via === '136151', 'the probe takes an explicit slot, recipient and sender');
    ok(probe.parseArgs(['--slot', '1']).yes === false,
      'the probe does NOT send without --yes: a real pairing credential over WhatsApp is never the default');
    const src = fs.readFileSync(probePath, 'utf8');
    ok(/qrEligibleStatus/.test(src) && /assertIndividualRecipient/.test(src),
      'the probe reuses the production gates rather than bypassing them - an active slot and a group recipient are refused there too');
    // The probe must resolve its expectation from the monitor's state file. It used to read the
    // SP_MAYTAPI_SENDER_NUMBER pin; when that was removed, the obvious edit - leave the call and drop
    // the env arg - resolves to null forever, and bindingGate() is permissive on a null expectation
    // BY DESIGN. That would have silently disarmed the wrong-handset refusal in the one script that
    // sends a real pairing credential to a real phone, with every test still green.
    ok(/readLastKnownNumber\(monitorStateFile\(env\)\)/.test(src),
      'the probe reads the expected number from the monitor state file, not from a null state that would make the binding gate permissive');
    ok(!/expectedSenderNumber\(null/.test(src),
      'and never passes a null state to the expectation reader');
  }

  // =========================================================================================
  // NO SCRIPT IMPORTS A NAME THIS MODULE DOES NOT EXPORT.
  //
  // Destructuring a missing export is silent: you get `undefined`, and it only throws at the call
  // site, in a script most runs never execute. This round removed three exports (the pin readers),
  // and the probe kept calling one of them with a now-ignored argument - caught by review, not by
  // the suite, because nothing executed that file. This check is the mechanical version of that
  // review, and it covers every future removal, not just this one.
  // =========================================================================================
  {
    const exported = new Set(Object.keys(require('./lib/sender-qr')));
    const dir = __dirname;
    let checked = 0;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      // Only the destructured-require form; a namespace import is resolved at the call site.
      const m = src.match(/const\s*\{([^}]*)\}\s*=\s*require\(['"](?:\.\/)?lib\/sender-qr['"]\)/);
      if (!m) continue;
      checked += 1;
      const names = m[1].split(',').map((x) => x.split(':')[0].trim()).filter(Boolean);
      const missing = names.filter((n) => !exported.has(n));
      ok(missing.length === 0, `${f} imports only names sender-qr.js actually exports${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
    }
    ok(checked >= 2, `the import check actually ran over the scripts that use the module (${checked} found)`);
  }

  completed = true;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { completed = true; console.error('FATAL', e); process.exit(1); });
