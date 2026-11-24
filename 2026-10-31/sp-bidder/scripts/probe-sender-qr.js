'use strict';
/**
 * PRE-ENABLE PROBE for the QR push tier. Runs the REAL fetch-and-send chain once, against a slot and
 * a recipient you name explicitly, and prints what happened.
 *
 * WHY THIS EXISTS. Every test of scripts/lib/sender-qr.js runs against an injected fake transport
 * that answers {success:true} unconditionally. Those tests prove the module emits the shape its
 * author believes is right; they cannot prove Maytapi accepts an ~8 KB base64 data URI on
 * sendMessage, and - the one that only ever shows up end to end - they cannot prove the delivered
 * image is still SCANNABLE after WhatsApp re-encodes it. A QR that arrives as a slightly soft
 * 300x300 JPEG-ish smear looks perfect in a screenshot and will not scan. Nothing short of a human
 * pointing the sender handset at a real received image settles that.
 *
 * The feature also makes its own verification hard on purpose: deliverQrRelink() fail-closes unless
 * the sender slot is genuinely not-active, so the send leg cannot be exercised without causing the
 * outage it detects. This script is the sanctioned way around that - you point it at a slot that is
 * ALREADY idle/logged-out (a spare, or the primary during a real incident), so nothing is taken down
 * to run it.
 *
 * THIS SENDS A REAL WHATSAPP MESSAGE CONTAINING A REAL PAIRING CREDENTIAL. It is interactive by
 * design: it prints the plan and requires --yes before any network write. It refuses a group
 * recipient through the same allowlist the production path uses, and it refuses to touch an ACTIVE
 * slot (which would pull from the /screen-adjacent family for a live session - see the module
 * header's /screen hazard note).
 *
 * USAGE
 *   node scripts/probe-sender-qr.js --slot <phoneId> --to <msisdn> [--via <phoneId>] [--yes]
 *
 *   --slot   the phone slot to READ the QR from. Must NOT be active. Required.
 *   --to     the individual admin MSISDN to send to (digits, country code, no '+'). Required.
 *   --via    the sibling slot to SEND from. Default: auto-pick an active sibling.
 *   --yes    actually send. Without it the script does the read leg and the eligibility checks,
 *            prints the plan, and stops before the write.
 *   --dry    do not even fetch; print the resolved plan and exit (offline sanity check).
 *
 * Credentials come from the same place the monitor reads them: MONITOR_APP_DIR/.env, overridden by
 * the real environment. Nothing is written to disk and the QR bytes are never logged.
 *
 * WHAT TO RECORD AFTERWARDS (this is the actual deliverable, not the exit code):
 *   1. the byte count of the fetched PNG and the sendMessage response;
 *   2. whether the image rendered in WhatsApp;
 *   3. whether a phone could SCAN it off another phone's screen - the whole point;
 *   4. the outcome, in scripts/lib/sender-qr.js's sendQrImage() header, with the same rigour the
 *      GET leg's probe record already has there.
 * Only then flip SP_WA_QR_IN_ALERT on.
 */
const {
  fetchPhones, fetchQr, sendQrImage, qrEligibleStatus, assertIndividualRecipient,
  bindingGate, buildQrCaption, readLastKnownNumber, monitorStateFile, relinkQrUrl, displayMsisdn, loadEnv,
} = require('./lib/sender-qr');

function parseArgs(argv) {
  const a = { slot: null, to: null, via: null, yes: false, dry: false };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--yes') a.yes = true;
    else if (t === '--dry') a.dry = true;
    else if (t === '--slot') { a.slot = argv[i + 1]; i += 1; }
    else if (t === '--to') { a.to = argv[i + 1]; i += 1; }
    else if (t === '--via') { a.via = argv[i + 1]; i += 1; }
  }
  return a;
}

function die(msg) { console.error(`\n[probe] REFUSED: ${msg}\n`); process.exit(2); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const base = (env.SP_MAYTAPI_ENDPOINT || 'https://api.maytapi.com/api').replace(/\/$/, '');
  const productId = env.SP_MAYTAPI_PRODUCT_ID;
  const token = env.SP_MAYTAPI_TOKEN;

  if (!productId || !token) die('missing SP_MAYTAPI_PRODUCT_ID / SP_MAYTAPI_TOKEN');
  if (!args.slot) die('--slot <phoneId> is required (the slot to read the QR FROM)');
  if (!args.to) die('--to <msisdn> is required (the individual admin number to send to)');

  // Same allowlist the production path uses - a group recipient is refused here too, before
  // anything touches the network.
  let to;
  try { to = assertIndividualRecipient(args.to); }
  catch (e) { die(e.message); }

  console.log('\n[probe] QR push-leg probe');
  console.log(`[probe]   product : ${productId}`);
  console.log(`[probe]   slot    : ${args.slot}   (QR is READ from here)`);
  console.log(`[probe]   to      : ${to}`);
  console.log(`[probe]   via     : ${args.via || '(auto-pick an active sibling)'}`);
  console.log(`[probe]   mode    : ${args.dry ? 'DRY (no network at all)' : args.yes ? 'LIVE SEND' : 'READ-ONLY (no send; pass --yes to send)'}`);

  if (args.dry) { console.log('\n[probe] --dry: stopping before any network call.\n'); return; }

  const board = await fetchPhones({ base, productId, token });
  if (!board.ok) die(`could not read the phone board: ${board.error}`);
  const slot = board.phones.find((p) => String(p.id) === String(args.slot)) || null;
  if (!slot) die(`slot ${args.slot} is not on this product's board`);
  console.log(`[probe]   slot status: ${slot.status}${slot.number == null ? ' / number:null' : ` / ${slot.number}`}`);

  // The same fail-closed eligibility rule production uses. An ACTIVE slot has no QR to show, and
  // pulling a screen-family image for a live session is the leak this module refuses to risk.
  if (!qrEligibleStatus(slot.status)) {
    die(`slot ${args.slot} status '${slot.status}' is not QR-eligible. Point --slot at a spare/idle slot, or run this during a real logout. Do NOT log a healthy sender out to run a probe.`);
  }
  // The number this slot is expected to be on, read from the monitor's state file. It used to come
  // from the SP_MAYTAPI_SENDER_NUMBER pin, which is gone; passing a null state instead would make
  // this resolve to null forever, and a null expectation makes bindingGate() permissive by design -
  // so the wrong-handset refusal below would be silently disabled in the one script that sends a
  // real pairing QR to a real phone. Read it once and reuse it for the gate and the caption.
  const expectedNumber = readLastKnownNumber(monitorStateFile(env));
  const bind = bindingGate(slot.number, expectedNumber);
  if (!bind.allowed) die(bind.reason);
  if (!expectedNumber) {
    console.log('[probe]   WARNING: no number on record for this slot, so the wrong-handset refusal cannot fire. Confirm the handset in the Maytapi console before you send.');
  }

  const via = args.via
    ? String(args.via)
    : String(((board.phones.find((p) => String(p.id) !== String(args.slot) && p.status === 'active' && p.number != null)) || {}).id || '');
  if (!via || via === 'undefined') die('no active sibling phone available to send FROM (pass --via explicitly)');
  const viaPhone = board.phones.find((p) => String(p.id) === via);
  if (!viaPhone || viaPhone.status !== 'active' || viaPhone.number == null) die(`--via ${via} is not an active, dialable phone`);
  console.log(`[probe]   via resolved: ${via} (${viaPhone.number})`);

  console.log('\n[probe] READ LEG - GET /qrCode ...');
  const qr = await fetchQr({ base, productId, phoneId: String(args.slot), token });
  if (!qr.ok) die(`read leg failed: ${qr.error}`);
  console.log(`[probe]   OK: PNG-signed, ${qr.bytes} bytes, ${Math.ceil(qr.base64.length / 1024)} KB as base64`);
  console.log('[probe]   (the QR bytes are held in memory only - never written to disk, never logged)');

  if (!args.yes) {
    console.log('\n[probe] READ-ONLY run complete. The send leg was NOT exercised.');
    console.log('[probe] Re-run with --yes to send this image, then CHECK ON A PHONE whether it scans.\n');
    return;
  }

  const caption = buildQrCaption({
    senderPhoneId: String(args.slot),
    expectedNumber,
    qrUrl: relinkQrUrl(env),
  });
  console.log('\n[probe] SEND LEG - POST /sendMessage (real WhatsApp message) ...');
  const res = await sendQrImage({ base, productId, via, token, to, base64: qr.base64, caption });
  if (!res.ok) die(`send leg failed: ${res.error}`);
  console.log(`[probe]   OK: maytapi success=true, messageId=${res.messageId || '(none returned)'}`);

  console.log('\n[probe] The API said yes. That is NOT the result you came for.');
  console.log('[probe] Now go and check, on a phone:');
  console.log('[probe]   1. did the image RENDER in WhatsApp?');
  console.log(`[probe]   2. does another phone actually SCAN it off the screen? (WhatsApp > Linked Devices > Link a Device, pointed at slot ${args.slot}'s code)`);
  console.log('[probe]   3. record bytes, response and the scan result in sendQrImage()\'s header.');
  console.log('[probe] Only after a YES on (2) is SP_WA_QR_IN_ALERT safe to turn on.');
  const expectedPretty = displayMsisdn(expectedNumber);
  if (expectedPretty) console.log(`[probe] Reminder: a real scan of this code binds slot ${args.slot} to the SCANNING handset. Expected handset is ${expectedPretty}.`);
  console.log('');
}

if (require.main === module) {
  main().catch((e) => { console.error(`[probe] fatal: ${e && e.message}`); process.exit(1); });
}

module.exports = { parseArgs };
