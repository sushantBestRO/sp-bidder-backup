'use strict';
/**
 * PRICE-ASK SENDER FAILOVER - the chain that runs when the primary Maytapi sender is logged out.
 *
 * THE INCIDENT THIS PINS (2026-08-06). Sender 128023 logged out at 07:04Z and stayed down ~2h for a
 * physical QR re-link. Every price ask in that window hit HEALTH_POLICY's 'retryable' classification,
 * was skipped at the health gate, and was re-fired by discovery into the same dead sender roughly
 * once per 30s tick until each load's pricing deadline passed. 8 asks EXPIRED undelivered; 10 more
 * were still undelivered when the incident was reviewed. Not one of them reached the wire.
 *
 * WHY NO FALLBACK FIRED. HEALTH_POLICY reasoned that a group broadcast cannot be rerouted, because a
 * sibling phone cannot post into a group it is not a member of. The premise is true. The conclusion
 * was wrong: a live read-only census (2026-08-06) shows the second controlled number 136151 is a
 * PARTICIPANT of 16 of the 18 live "BRL Bids" groups. A sender already in the group can post the ask.
 *
 * THE FIX under test: price_needed is classified 'failover', and per group the chain tries, stopping
 * at the FIRST success - another healthy controlled sender VERIFIED to be a participant of that
 * specific group, then the customer's designated desk owners by DM, then email, then the old skip.
 *
 * FIX-FLIP. Every assertion in blocks (1)-(6) FAILS against unpatched main, where price_needed is
 * 'retryable' and _whatsapp returns false at the health gate before any delivery is attempted: there
 * is no sibling send to observe (1), nothing is marked sent so recovery re-sends (2), no owner DM (4)
 * and no email (5) exist at all. Blocks (7)-(9) are the OVER-reach guards - they must hold both
 * before and after, and they are what proves the fix never posts into a group it has not verified,
 * never posts onto a dead session, and costs nothing when the primary is healthy.
 */
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { SenderFleet } = require('../src/notify/senderFleet');
const { Notifier, DEDUPE_COLLECTION } = require('../src/notify/notifier');
const { MemoryStore } = require('../src/store');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const PRODUCT = 'p';
const PRIMARY = '128023';        // 918882034647 - member of all 18 live groups
const SIBLING = '136151';        // 919594964196 - member of 16 of 18
const STRANGER = '127918';       // 919594964195 - active, member of ZERO "BRL Bids" groups

const HAVELLS = '120363431523383103@g.us';   // both PRIMARY and SIBLING are members (live census)
const CORDS = '120363428359034400@g.us';     // PRIMARY only - SIBLING is NOT a member (live census)

const OWNER = { personId: 'p1', name: 'Desk Owner', phone: '919000000001' };

/**
 * A transport that models a Maytapi PRODUCT with several linked phones. Routes by the phoneId in the
 * URL path, so a test can assert not just THAT something was sent but WHICH phone sent it - the
 * distinction the whole failover turns on.
 *
 *   down    : phoneIds whose session is logged out (listPhones reports them non-active). A POST to
 *             one still returns ok:true, because that IS the live hazard - Maytapi accepts and QUEUES
 *             for a dead session. So "no POST reached the down phone" has to be asserted from the
 *             call log; the response can never reveal it.
 *   groups  : phoneId -> [group jid] membership, what getGroups returns for that phone.
 *   unreadable : phoneIds whose getGroups fails (success:false), the fail-closed case.
 */
function fleetTransport({ down = [], groups = {}, unreadable = [] } = {}) {
  const sends = [];   // { phoneId, to, message }
  const reads = [];   // { phoneId, op }
  const downSet = new Set(down.map(String));
  const fn = async (url, opts) => {
    const mSend = url.match(/\/(\d+)\/sendMessage$/);
    if (mSend) {
      const body = JSON.parse(opts.body);
      sends.push({ phoneId: mSend[1], to: body.to_number, message: body.message, replyTo: body.reply_to || null });
      return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: `m${sends.length}` } }) };
    }
    const mGroups = url.match(/\/(\d+)\/getGroups$/);
    if (mGroups) {
      const id = mGroups[1];
      reads.push({ phoneId: id, op: 'getGroups' });
      if (unreadable.map(String).includes(id)) return { ok: true, status: 200, json: async () => ({ success: false, message: 'nope' }) };
      return { ok: true, status: 200, json: async () => ({ success: true, data: (groups[id] || []).map((jid) => ({ id: jid, name: 'g', participants: [], admins: [] })) }) };
    }
    if (/listPhones$/.test(url)) {
      reads.push({ op: 'listPhones' });
      return { ok: true, status: 200, json: async () => ({ data: [PRIMARY, SIBLING, STRANGER].map((id) => ({ id, number: `9${id}`, status: downSet.has(id) ? 'loading' : 'active' })) }) };
    }
    return { ok: false, status: 404, json: async () => ({ success: false }) };
  };
  fn.sends = sends; fn.reads = reads;
  fn.sentBy = (id) => sends.filter((s) => s.phoneId === String(id));
  // Null-safe first-send accessor. Without it a block whose delivery did not happen throws on the
  // next assertion's property read, the run aborts, and a fix-flip reports ONE failure instead of the
  // real blast radius - which is exactly the evidence a flip is supposed to produce.
  fn.firstBy = (id) => fn.sentBy(id)[0] || { phoneId: null, to: null, message: '' };
  return fn;
}

// The recipient row shape toRecipientRows emits for a scoped customer GROUP.
const groupRow = (phone, name, shipper) => ({ name, phone, alerts: ['price_needed'], scope: { shippers: [shipper] } });

const REQ = (id, shipper) => ({ id, loadId: `L${id}`, load: { lane: { origin: 'A', destination: 'B' }, companyName: shipper, closesAt: 1751000000000 } });

/** Build the whole stack with one call so each block differs only in the thing it is testing. */
function stack({ transport, fleetIds = [PRIMARY, SIBLING], recipients, owners = null, fallbackAlert = null, store = new MemoryStore() }) {
  const mk = (id) => new WhatsAppClient({ enabled: true, token: 't', productId: PRODUCT, phoneId: id, transport });
  const wa = mk(PRIMARY);
  const fleet = new SenderFleet({ clients: fleetIds.map((id) => (id === PRIMARY ? wa : mk(id))) });
  const n = new Notifier({
    mode: 'whatsapp', baseUrl: 'http://h', wa, store,
    recipientsProvider: async () => recipients,
    healthProvider: () => wa.sessionHealthy(),
    senderFleet: fleet,
    ownersProvider: owners,
    fallbackAlert,
  });
  return { n, wa, store, fleet };
}

(async () => {
  // ---- (1) THE HEADLINE: primary DOWN, a sibling IS in the group -> the ask is DELIVERED --------
  // On unpatched main this whole block is unreachable: _whatsapp returns false at the health gate and
  // zero sends of any kind occur.
  {
    const tr = fleetTransport({ down: [PRIMARY], groups: { [PRIMARY]: [HAVELLS], [SIBLING]: [HAVELLS] } });
    const { n } = stack({ transport: tr, recipients: [groupRow(HAVELLS, 'Havells group', 'Havells')] });
    const res = await n.requestPrice(REQ('rq1', 'Havells'));

    ok(tr.sentBy(PRIMARY).length === 0, 'primary DOWN -> ZERO POSTs onto the dead sender (nothing queued to flood on re-link)');
    ok(tr.sentBy(SIBLING).length === 1, 'the ask is delivered by the SIBLING sender that is a member of that group');
    ok(tr.firstBy(SIBLING).to === HAVELLS, 'it goes to the SAME customer group, not to some other channel');
    ok(res && res.delivered === true, 'requestPrice reports delivered:true, so discovery marks it notified and stops re-firing');
    ok(/Havells/.test(tr.firstBy(SIBLING).message), 'the fallback carries the SAME ask body (same load detail)');
    ok(/backup number/.test(tr.firstBy(SIBLING).message), 'the fallback says it came from the backup number, so an unfamiliar sender is not read as a scam');
    ok(/\/price\//.test(tr.firstBy(SIBLING).message), 'the /price capture link rides the fallback unchanged - it is sender-agnostic, so the ask stays actionable');
  }

  // ---- (2) IDEMPOTENT ACROSS RECOVERY - the single most dangerous failure mode ------------------
  // A fallback delivery MUST mark the dedupe key. Without it, every ask delivered during the outage
  // is re-sent into every group the moment the primary re-links - 18 groups of duplicate asks on
  // loads that were already priced, which is strictly worse than the outage this fixes.
  {
    const tr = fleetTransport({ down: [PRIMARY], groups: { [PRIMARY]: [HAVELLS], [SIBLING]: [HAVELLS] } });
    const store = new MemoryStore();
    const { n } = stack({ transport: tr, store, recipients: [groupRow(HAVELLS, 'Havells group', 'Havells')] });
    await n.requestPrice(REQ('rq2', 'Havells'));
    ok(tr.sentBy(SIBLING).length === 1, 'setup: the fallback delivered once');
    ok(!!(await store.getDoc(DEDUPE_COLLECTION, 'rq2_price_needed')), 'a FALLBACK delivery marks the persistent dedupe key, exactly as a healthy send does');

    // The primary recovers. Re-fire the same request (a restart replaying a tick, or discovery
    // having never marked it). Nothing may go out - on EITHER sender.
    const trUp = fleetTransport({ groups: { [PRIMARY]: [HAVELLS], [SIBLING]: [HAVELLS] } });
    const mk = (id) => new WhatsAppClient({ enabled: true, token: 't', productId: PRODUCT, phoneId: id, transport: trUp });
    const wa2 = mk(PRIMARY);
    const n2 = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', wa: wa2, store,
      recipientsProvider: async () => [groupRow(HAVELLS, 'Havells group', 'Havells')],
      healthProvider: () => wa2.sessionHealthy(),
      senderFleet: new SenderFleet({ clients: [wa2, mk(SIBLING)] }),
    });
    const again = await n2.requestPrice(REQ('rq2', 'Havells'));
    ok(trUp.sends.length === 0, 'REGRESSION GUARD: after recovery the SAME ask is NOT re-sent by the primary (no duplicate on re-link)');
    ok(again && again.delivered === true, 'the recovered re-fire reports delivered (already-sent), so discovery stops rather than looping');
  }

  // ---- (3) NEVER post into a group the sender is not verified to be in -------------------------
  // Cords Cable is the live case: the primary is a member, the sibling is NOT. The sibling must not
  // be used for it even though it is healthy and in the fleet.
  {
    const tr = fleetTransport({ down: [PRIMARY], groups: { [PRIMARY]: [HAVELLS, CORDS], [SIBLING]: [HAVELLS] } });
    const { n } = stack({
      transport: tr, recipients: [groupRow(CORDS, 'Cords Cable group', 'Cords')],
      owners: async () => [OWNER],
    });
    await n.requestPrice(REQ('rq3', 'Cords'));
    ok(tr.sends.filter((s) => s.to === CORDS).length === 0, 'a sender that is NOT a verified participant NEVER posts into that group');
    ok(tr.sentBy(SIBLING).length === 1 && tr.firstBy(SIBLING).to === OWNER.phone,
      'with no controlled sender able to reach the group, it steps down to the desk OWNER by DM');
    ok(/could not be reached/.test(tr.firstBy(SIBLING).message), 'the owner DM says the desk has NOT seen the ask, so it is not dismissed as a duplicate');
  }

  // ---- (4) STOP AT THE FIRST SUCCESS - one delivery per ask, not one per channel ----------------
  {
    const emails = [];
    const tr = fleetTransport({ down: [PRIMARY], groups: { [PRIMARY]: [HAVELLS], [SIBLING]: [HAVELLS] } });
    const { n } = stack({
      transport: tr, recipients: [groupRow(HAVELLS, 'Havells group', 'Havells')],
      owners: async () => [OWNER],
      fallbackAlert: async (a) => { emails.push(a); return { ok: true }; },
    });
    await n.requestPrice(REQ('rq4', 'Havells'));
    ok(tr.sentBy(SIBLING).length === 1, 'the sibling delivered the group ask');
    ok(tr.sends.filter((s) => s.to === OWNER.phone).length === 0, 'a group reached by a sibling does NOT also DM the owner');
    ok(emails.length === 0, 'and does NOT also email - exactly one delivery per ask');
  }

  // ---- (5) EMAIL is the last resort, and only when nothing above it worked ----------------------
  {
    const emails = [];
    const tr = fleetTransport({ down: [PRIMARY], groups: { [PRIMARY]: [CORDS], [SIBLING]: [] } });
    const { n } = stack({
      transport: tr, recipients: [groupRow(CORDS, 'Cords Cable group', 'Cords')],
      owners: async () => [],                       // this customer has NO designated owner
      fallbackAlert: async (a) => { emails.push(a); return { ok: true }; },
    });
    const res = await n.requestPrice(REQ('rq5', 'Cords'));
    ok(tr.sends.length === 0, 'no group send and no owner DM were possible');
    ok(emails.length === 1, 'a customer with NO desk owner falls through to email rather than guessing a human');
    ok(/PRICE NEEDED/.test((emails[0] || {}).subject || ''), 'the email names what it is');
    ok(res && res.delivered === true, 'an emailed ask counts as delivered, so it is not re-fired forever');
  }

  // ---- (6) EVERY route failed -> the OLD behaviour, unchanged: retryable, NOT marked -------------
  {
    const tr = fleetTransport({ down: [PRIMARY, SIBLING], groups: { [PRIMARY]: [HAVELLS], [SIBLING]: [HAVELLS] } });
    const store = new MemoryStore();
    const { n } = stack({ transport: tr, store, recipients: [groupRow(HAVELLS, 'Havells group', 'Havells')], owners: async () => [] });
    const res = await n.requestPrice(REQ('rq6', 'Havells'));
    ok(tr.sends.length === 0, 'no healthy sender anywhere -> nothing is posted onto any dead session');
    ok(res && res.delivered === false, 'it degrades to the ORIGINAL retryable skip, so discovery keeps trying while the load is open');
    ok(!(await store.getDoc(DEDUPE_COLLECTION, 'rq6_price_needed')), 'a failed chain is NOT marked sent, so it stays retryable');
  }

  // ---- (7) OVER-REACH GUARD: health-gate EVERY candidate, not just the primary ------------------
  // The sibling is a member of the group but its own session is down. It must be skipped, not used.
  {
    const tr = fleetTransport({ down: [PRIMARY, SIBLING], groups: { [PRIMARY]: [HAVELLS], [SIBLING]: [HAVELLS], [STRANGER]: [HAVELLS] } });
    const { n } = stack({
      transport: tr, fleetIds: [PRIMARY, SIBLING, STRANGER],
      recipients: [groupRow(HAVELLS, 'Havells group', 'Havells')],
    });
    await n.requestPrice(REQ('rq7', 'Havells'));
    ok(tr.sentBy(SIBLING).length === 0, 'a DOWN sibling is health-gated out even though it IS a member of the group');
    ok(tr.sentBy(STRANGER).length === 1, 'the chain walks PAST it to the next healthy member - N-deep, not two-deep');
  }

  // ---- (8) OVER-REACH GUARD: an UNREADABLE membership is never treated as "is a member" ---------
  // getGroups is fail-closed by contract. A sender whose membership cannot be read must not be used:
  // guessing yes posts into a group we may not be in, and this is a customer-visible surface.
  {
    const tr = fleetTransport({ down: [PRIMARY], groups: { [PRIMARY]: [HAVELLS] }, unreadable: [SIBLING] });
    const { n } = stack({ transport: tr, recipients: [groupRow(HAVELLS, 'Havells group', 'Havells')], owners: async () => [] });
    await n.requestPrice(REQ('rq8', 'Havells'));
    ok(tr.sentBy(SIBLING).length === 0, 'an UNREADABLE membership is treated as "cannot verify" and the sender is skipped, never assumed in');
  }

  // ---- (9) OVER-REACH GUARD: ZERO added cost when the primary is healthy ------------------------
  // The whole fleet must be inert on the happy path - same wire ops as before this feature existed.
  {
    const tr = fleetTransport({ groups: { [PRIMARY]: [HAVELLS], [SIBLING]: [HAVELLS] } });
    const { n } = stack({ transport: tr, recipients: [groupRow(HAVELLS, 'Havells group', 'Havells')] });
    await n.requestPrice(REQ('rq9', 'Havells'));
    ok(tr.sentBy(PRIMARY).length === 1 && tr.sends.length === 1, 'healthy primary -> exactly ONE send, from the primary, as before');
    ok(tr.reads.filter((r) => r.op === 'getGroups').length === 0, 'healthy primary -> ZERO membership reads; the fleet is never consulted');
  }

  // ---- (10) a cross-sender ask thread is not quoted by a different phone ------------------------
  // The fallback records the ask anchor stamped with the phone that minted it. Cross-phone reply_to
  // is unverified on this account, so the later outcome must degrade to a fresh send rather than
  // gamble the load's outcome message on a quote that may silently no-op.
  {
    const tr = fleetTransport({ down: [PRIMARY], groups: { [PRIMARY]: [HAVELLS], [SIBLING]: [HAVELLS] } });
    const store = new MemoryStore();
    const rows = [{ name: 'Havells group', phone: HAVELLS, alerts: ['price_needed', 'won'], scope: { shippers: ['Havells'] } }];
    const { n } = stack({ transport: tr, store, recipients: rows });
    await n.requestPrice(REQ('rq10', 'Havells'));
    ok(tr.sentBy(SIBLING).length === 1, 'setup: the sibling minted the ask anchor');

    // Primary recovers and the load is won. It must NOT reply_to the sibling's message id.
    const trUp = fleetTransport({ groups: { [PRIMARY]: [HAVELLS], [SIBLING]: [HAVELLS] } });
    const wa2 = new WhatsAppClient({ enabled: true, token: 't', productId: PRODUCT, phoneId: PRIMARY, transport: trUp });
    const n2 = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', wa: wa2, store,
      recipientsProvider: async () => rows, healthProvider: () => wa2.sessionHealthy(),
    });
    await n2.alert('won', { auctionId: 'L rq10', loadId: 'Lrq10', shipper: 'Havells', origin: 'A' }, { dedupeKey: 'rq10_won' });
    const quoted = trUp.sends.filter((s) => s.to === HAVELLS);
    ok(quoted.length === 1, 'the outcome still reaches the group after recovery');
    // Asserted on reply_to specifically, not on a stringified blob: the wire field IS the quote, and
    // a blob check passes vacuously whenever the transport does not record it.
    ok((quoted[0] || {}).replyTo === null, 'it does NOT quote the sibling-minted message id - it degrades to a fresh send');
  }

  // ---- (10) a FAILOVER delivery records the same delivery evidence an ordinary send does --------
  // _whatsapp has TWO delivery exits and wasDelivered must not disagree between them. Pinned with
  // the dedupe write failing, because that is the only case where the in-process record and the
  // persisted mark can diverge - and a caller that retries undelivered pages would then re-send an
  // ask a desk already received, once per retry tick.
  {
    const tr = fleetTransport({ down: [PRIMARY], groups: { [PRIMARY]: [HAVELLS], [SIBLING]: [HAVELLS] } });
    const store = new MemoryStore();
    const put = store.putDoc.bind(store);
    store.putDoc = async (coll, k, d) => { if (coll === DEDUPE_COLLECTION) throw new Error('ENOSPC'); return put(coll, k, d); };
    const { n } = stack({ transport: tr, store, recipients: [groupRow(HAVELLS, 'Havells group', 'Havells')] });
    await n.requestPrice(REQ('rq10', 'Havells'));
    ok(tr.sentBy(SIBLING).length === 1, 'setup: the fallback delivered once with a broken dedupe store');
    ok((await n.wasDelivered('rq10_price_needed')) === true,
      'a failover delivery reads as DELIVERED even when its mark write throws - both exits agree');
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
