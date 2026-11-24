'use strict';
/*
 * reconcile-desk-owners.js - reconcile CONFIRMED BRL desk-owner identities (from the
 * "BRL Bids - Desk Owner Gaps" Google sheet) into the bidder's stores on the box.
 *
 * Data-driven + idempotent + no PM2 restart needed (heartbeat/notifier re-read data live).
 * Uses the app's OWN store modules so shape + validation match exactly. Run:
 *     node scripts/reconcile-desk-owners.js
 *
 * Edit the two arrays below as the sheet gets filled. Golden rule (from the 2026-07-21
 * membership audit): NEVER add a number you cannot confidently name - a wrong roster entry
 * becomes a permanent tripwire blind spot. Confirmed-only.
 *
 *   ROSTER_ADD  - confirmed BRL-staff numbers to ensure on the allowlist (stops the 08:00
 *                 tripwire flagging them). Roster-only = "not an intruder", nothing else.
 *   OWNERS      - confirmed desk owners to model as a person + customer assignment(s), so
 *                 they receive their customer's alerts (matches how Sameer/Pavan are set up).
 *                 accountId + alertPrefs are cloned from an existing confirmed owner (TEMPLATE).
 */

const config = require('../src/config');
const { createStore } = require('../src/store');
const { PersonStore } = require('../src/model/personStore');
const { AssignmentStore } = require('../src/model/assignmentStore');
const { CustomerStore } = require('../src/model/customerStore');
const { StaffRoster } = require('../src/model/staffRoster');

// Clone accountId + alertPrefs from this confirmed desk owner so new owners match the house shape.
const TEMPLATE_PERSON_ID = 'p919594963428'; // Sameer Ambadaskar

// --- edit these two as the sheet fills -------------------------------------------------
const ROSTER_ADD = [
  '+919887877477', // Neemrana desk (Ashirvad Pipes) - CONFIRMED, already in people.json
  '+919999444060', // Rakesh Kapoor (Noida) - CONFIRMED, already in people.json
  '+917838323242', // Gurdeep Singh (Ludhiana, Safex) - CONFIRMED, already in people.json
  '+919594963410', // Keshav Naiknawre (ION Exchange) - CONFIRMED owner, no group yet
  '+919594963311', // Akash (Nagpur: Transrail/Rallis/Hindalco) - CONFIRMED owner, no group yet
  // 2026-07-24: the five numbers the tripwire flagged, now named by Sid (all BRL staff, in-group)
  '+917838323213', // Neelam (Ludhiana / 78383 block) - Havells group
  '+919982761777', // Pankaj Sharma (Alwar) - Havells + KEI groups
  // CORRECTED 2026-07-27: this is PRIYANKA TRIVEDI (also goes by Priyanka Sharma - Shishir
  // confirmed same person, surname Trivedi), NOT Subham Singh. The Jul-24 "Subham" label was an
  // INFERENCE, never a confirmation: the number showed up in the Havells group, Subham was the
  // known Havells person, so it was assumed to be a second handset of his. Two independent
  // sources now say otherwise - Shishir named it directly, and Sid took a call from it where the
  // caller identified as Sharma. Subham's real number is 69065 (the sheet survey's "official").
  // Priyanka shares the Epack/Paragon/Luminous/Ashirvad/Vishal desk with Vipul Verma (69079).
  '+918929569051', // Priyanka Trivedi (aka Priyanka Sharma) - Epack desk
  '+919983186777', // Mahendra - Havells + KEI groups
  '+919311616777', // Parveen Mangla - Borosil group
  '+918929569065', // Subham Singh's OFFICIAL number (sheet survey) - now in Havells (69051 also his)
  // 2026-07-24 batch 2 - the remaining GAPS-2 numbers, named by the desk (all BRL staff)
  '+919811330777', // Ashish Gupta - shared desk (Borosil, Tata, Havells, KEI)
  '+919999689877', // Sahil Gupta - shared desk (Borosil, Tata, Havells, KEI)
  '+918668332857', // Avinash Kapse - ADAMA (CONFIRMED BRL staff, NOT an ADAMA outsider)
  '+918806337895', // Avinash Kapse (second number) - ADAMA (CONFIRMED BRL staff)
  '+917838323217', // Mahipal (78383 north-India branch block) - Borosil, Havells
  '+918929569068', // Ramdhari (89295 block) - Borosil
  '+919594964196', // held with Sushant Govinde for Waaree notifications - Tata group
  '+919311444036', // Hardeep Singh - Havells
  // 2026-07-27: named on the sheet (Owner Map row 39) after the batch-2 reconcile, never
  // rostered - which is why the 08:00 tripwire kept flagging it in the Durian group.
  '+919594963406', // Gopal Jha - Durian
  // 2026-07-27: named by Shishir after the 08:00 tripwire flagged it in the Havells group.
  // Vipul Verma, BRL staff - handles Epack, Paragon, Luminous, Automat, Ashirvad, Century Ply,
  // Vishal Pipe, Apollo Pipe, Haldiram, Crystal (shares that desk with Priyanka Trivedi, whose
  // number is not yet supplied). Note: Havells is NOT on his stated customer list - he is in
  // that group for a reason nobody has explained, which is worth asking about but is not a
  // blocker: he is confirmed staff, so rostering him is correct and stops the false alarm.
  '+918929569079', // Vipul Verma - Epack desk (+ 9 other customers)
];

const OWNERS = [
  // 9624094477 was a SUSPECTED ADAMA-customer number in the Jul-21 audit; the sheet CONFIRMS
  // it is Virendra Singh (Ankleshwar branch), BRL staff, ADAMA owner. Already in the ADAMA
  // group + on the roster; this models him as the owner so ADAMA alerts reach him directly.
  // enabled:true is EXPLICIT and load-bearing - ADAMA is already live and this assignment
  // already exists enabled on the box. Omitting it would flip it to disabled on the next run.
  { number: '+919624094477', name: 'Virendra Singh', email: 'virendra.singh@bestroadways.com',
    customers: ['adama'], enabled: true },
  // 2026-07-27: ION Exchange's ONLY named owner (sheet Owner Map row 11). Person record is
  // seeded but the assignment is DISABLED - see the warning below. Re-enable only as part of
  // a deliberate ION go-live (right account + group + margin floor + supervised first bid).
  { number: '+919594963410', name: 'Keshav Naiknawre', email: 'keshav.naiknawre@bestroadways.com',
    accountId: 'master', customers: ['ion-exchange'], enabled: false },
];

/*
 * ============================ READ BEFORE ADDING AN OWNER ============================
 *
 * AN ENABLED ASSIGNMENT IS A LIVE BIDDING SWITCH. It is NOT just alert routing.
 *
 * resolveTargets (src/model/resolve.js) computes an account's effective bidding targets as
 * the UNION of the base allowlist AND the aliases of every customer with an ENABLED
 * assignment via an ENABLED person on that account. So adding an owner here surfaces that
 * customer's loads and starts the bid path WITHOUT anyone touching config.allowlist.shippers.
 *
 * Proven live 2026-07-27: seeding Keshav -> ion-exchange put "ION Exchange" into
 * sameer-ambdaskar's effective targets immediately. Caught and reverted before any load
 * surfaced (0 price requests, 0 bids). Do not assume the allowlist is the only gate.
 *
 * TWO RULES:
 *   1. accountId is now EXPLICIT per owner and must be the account that actually holds
 *      carrier access for that customer (ION = 85486 via master; NOT the Sameer template).
 *      Cloning it from TEMPLATE_PERSON_ID silently attaches an owner to the wrong account,
 *      which bids as the wrong carrier and gets rejected by SuperProcure.
 *   2. New owners land with enabled:false. Flip to true only alongside the customer's group,
 *      its per-customer margin floor (L12, Suyashh's call), and a supervised first bid.
 * ====================================================================================
 */
// HELD (do not add without desk confirmation):
//   Prashant Pawar +919594972667 -> renewsys  (GAPS 1; sheet note still questions Renewsys owner)
//   Subham Singh   +918929569065 -> havells    (sheet says "please confirm"; his number not in the group)
//   Gurdeep Singh  +917838323242 -> safex-chemicals
//     HELD ON TWO SEPARATE THINGS, and neither is the person. Gurdeep is CONFIRMED BRL staff and is
//     already rostered above (Ludhiana, Safex), so the roster half of Safex's wiring is DONE.
//     (1) accountId is genuinely unknown, and Rule 1 above makes that a money-path question, not a
//         formality: Safex is visible on BOTH 'ludhiana' and 'master' (2026-07-28 flow-gap pass),
//         while the v4 board capture puts its load on carrier 5963 - the same carrier Cords Cable
//         reaches "via master umbrella". Cloning the Sameer template, or guessing between the two,
//         attaches the owner to the wrong account, which bids as the wrong carrier and gets
//         rejected by SuperProcure. Read the account that actually holds carrier access for Safex
//         off a real Safex load before filling this in.
//     (2) Safex's BID MECHANIC is unresolved (auction vs open board, n=1 in both directions - see
//         the SAFEX block in scripts/onboard-w3-customers.js and the .env.example W3 section).
//         Until that is settled, an enabled assignment would surface a customer we cannot yet say
//         we can bid. Note this is NOT merely alert routing: per the warning block above,
//         resolveTargets unions an ENABLED assignment's customer aliases into the account's
//         effective bidding targets with no allowlist edit at all - which is exactly how ION
//         Exchange went live by accident on 2026-07-27. When it is added, it lands enabled:false.
// ---------------------------------------------------------------------------------------

const canon = (s) => String(s || '').replace(/\D/g, '').replace(/^0*91/, '');

(async () => {
  const store = createStore({ dataDir: config.dataDir });
  const people = new PersonStore({ store });
  const customers = new CustomerStore({ store });
  const assignments = new AssignmentStore({ store, people, customers });
  const roster = new StaffRoster({ store });

  const tpl = await people.get(TEMPLATE_PERSON_ID);
  if (!tpl) throw new Error(`template person ${TEMPLATE_PERSON_ID} not found`);
  console.log(`template: accountId=${tpl.accountId} alertPrefs=${JSON.stringify(tpl.alertPrefs)}`);

  // 1) Roster: union current + ROSTER_ADD (dedup by 10-digit core), only if anything is new.
  const current = await roster.list();
  const have = new Set(current.map(canon));
  const toAdd = ROSTER_ADD.filter((n) => !have.has(canon(n)));
  if (toAdd.length) {
    await roster.replace([...current, ...toAdd], { updatedBy: 'sid-desk-reconcile-20260724' });
    console.log(`ROSTER  -> added ${toAdd.length} (${toAdd.join(', ')}); now ${(await roster.list()).length}`);
  } else {
    console.log(`ROSTER  -> nothing new (all ${ROSTER_ADD.length} already present); ${current.length} total`);
  }

  // 2) Owners: person (cloned shape) + one assignment per customer. Roster them too.
  for (const o of OWNERS) {
    // accountId: EXPLICIT per owner when given (must be the account holding carrier access for
    // that customer); falls back to the template only for owners that genuinely sit on it.
    // Cloning it blindly attaches an owner to the wrong account -> wrong carrier -> SP rejects.
    const p = await people.upsert({
      name: o.name, phone: o.number, email: o.email || null,
      accountId: o.accountId || tpl.accountId, alertPrefs: tpl.alertPrefs, alertAll: false,
      originScope: [], enabled: true,
    });
    console.log(`PERSON  -> ${p.personId} ${p.name} (${p.phone})`);
    const r2 = await roster.list();
    if (!new Set(r2.map(canon)).has(canon(o.number))) {
      await roster.replace([...r2, o.number], { updatedBy: 'sid-desk-reconcile-20260724' });
      console.log(`ROSTER  -> +${o.number} (owner)`);
    }
    // enabled: an ENABLED assignment is a LIVE BIDDING SWITCH (resolveTargets unions the
    // customer's aliases into the account's effective targets - no allowlist edit needed).
    // Default to DISABLED so a new owner never silently starts bidding a customer; the owner
    // must opt in explicitly with enabled:true once group + margin + supervised bid are done.
    const enabled = o.enabled === true;
    for (const cust of o.customers || []) {
      const a = await assignments.upsert({ personId: p.personId, customerId: cust, lanes: null, marginOverride: null, alertKinds: null, enabled });
      console.log(`ASSIGN  -> ${a.assignmentId} enabled=${a.enabled}${enabled ? '  *** LIVE BIDDING TARGET ***' : ''}`);
    }
  }

  console.log(`\nDONE. roster=${(await roster.list()).length} people=${(await people.list()).filter((x) => !String(x.phone).includes('@g.us')).length}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
