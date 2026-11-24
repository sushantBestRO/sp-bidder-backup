'use strict';
/*
 * designate-desk-owners.js - mark WHO OWNS each customer's bidding desk (`owner:true` on the
 * assignment), which is what @-mention routing tags. Confirmed by Sid 2026-07-25 off the
 * "BRL Bids - Desk Owner Gaps" sheet.
 *
 *   node scripts/designate-desk-owners.js            # DRY RUN - prints the plan, writes nothing
 *   node scripts/designate-desk-owners.js --apply    # writes
 *
 * HARD DEPENDENCY - read before running with --apply. `owner` only exists in validateAssignment as
 * of the mention-owner-resolution change. On any build WITHOUT it, upsert() silently DROPS the
 * field: the run reports success and designates nobody. The script therefore self-checks and
 * refuses to apply against a build that would strip it, rather than producing a confident no-op.
 *
 * Ownership is deliberately NOT the same as alert routing. Suyashh and Sid keep their assignments
 * to nearly every customer (oversight) and keep receiving everything - they are simply never
 * tagged as the accountable desk on a load they do not price.
 */

const config = require('../src/config');
const { createStore } = require('../src/store');
const { PersonStore } = require('../src/model/personStore');
const { AssignmentStore } = require('../src/model/assignmentStore');
const { CustomerStore } = require('../src/model/customerStore');
const { validateAssignment } = require('../src/model/assignmentStore');

const APPLY = process.argv.includes('--apply');
const TEMPLATE_PERSON_ID = 'p919594963428'; // Sameer - clone accountId/alertPrefs for any new person

// person (by phone) -> the customers whose DESK they own.
// `create` is present only for people not yet in people.json.
const OWNERS = [
  { phone: '+919594963428', name: 'Sameer AmbadaskaR', customers: ['borosil', 'durian', 'syngenta'] },
  { phone: '+919090707777', name: 'Pavan Konda', customers: ['borosil', 'durian', 'syngenta'] },
  { phone: '+919624094477', name: 'Virendra Singh', customers: ['adama'] },
  { phone: '+919982893777', name: 'Balkishan Sharma', customers: ['kei-industries'] },
  { phone: '+918929569065', name: 'Subham Singh', customers: ['havells'], create: { email: 'subham.singh@bestroadways.com' } },
  { phone: '+919594972667', name: 'Prashant Pawar', customers: ['renewsys'], create: { email: 'prashant.pawar@bestroadways.com' } },
];

const canon = (s) => String(s || '').replace(/\D/g, '').replace(/^0*91/, '');

(async () => {
  // Self-check: would this build persist `owner` at all?
  const probe = validateAssignment({ personId: 'x', customerId: 'y', owner: true });
  const supported = probe.owner === true;
  console.log(`build supports owner flag: ${supported}`);
  if (!supported) {
    console.log('\nREFUSING to apply: this build strips `owner`, so the run would designate NOBODY');
    console.log('while reporting success. Deploy the mention-owner-resolution change first.');
    if (APPLY) process.exit(1);
    console.log('(continuing in dry-run to show the plan)\n');
  }

  const store = createStore({ dataDir: config.dataDir });
  const people = new PersonStore({ store });
  const customers = new CustomerStore({ store });
  const assignments = new AssignmentStore({ store, people, customers });

  const tpl = await people.get(TEMPLATE_PERSON_ID);
  const allPeople = await people.list();
  const allCustomers = new Set((await customers.list()).map((c) => c.customerId));
  const byPhone = new Map(allPeople.map((p) => [canon(p.phone), p]));
  const existing = await assignments.list();
  const byId = new Map(existing.map((a) => [a.assignmentId, a]));

  const plan = { createPerson: [], createAssignment: [], flagOwner: [], alreadyOwner: [], missingCustomer: [] };

  for (const o of OWNERS) {
    let person = byPhone.get(canon(o.phone));
    if (!person) plan.createPerson.push(o);
    for (const cust of o.customers) {
      if (!allCustomers.has(cust)) { plan.missingCustomer.push(`${o.name} -> ${cust}`); continue; }
      const id = `${person ? person.personId : 'p91' + canon(o.phone)}::${cust}`;
      const a = byId.get(id);
      if (!a) plan.createAssignment.push({ o, cust, id });
      else if (a.owner === true) plan.alreadyOwner.push(id);
      else plan.flagOwner.push({ a, id });
    }
  }

  const show = (label, rows) => { console.log(`\n${label} (${rows.length})`); for (const r of rows) console.log('  - ' + r); };
  show('NEW PEOPLE to create', plan.createPerson.map((o) => `${o.name} ${o.phone}`));
  show('NEW ASSIGNMENTS to create (owner:true)', plan.createAssignment.map((r) => r.id));
  show('EXISTING assignments to flag owner:true', plan.flagOwner.map((r) => r.id));
  show('already owner:true (no-op)', plan.alreadyOwner);
  show('SKIPPED - customer not in the model', plan.missingCustomer);

  if (!APPLY) { console.log('\nDRY RUN - nothing written. Re-run with --apply to write.'); return; }

  for (const o of plan.createPerson) {
    const p = await people.upsert({
      name: o.name, phone: o.phone, email: (o.create && o.create.email) || null,
      accountId: tpl ? tpl.accountId : 'primary', alertPrefs: tpl ? tpl.alertPrefs : [],
      alertAll: false, originScope: [], enabled: true,
    });
    byPhone.set(canon(p.phone), p);
    console.log(`PERSON  -> ${p.personId} ${p.name}`);
  }
  for (const { o, cust } of plan.createAssignment) {
    const person = byPhone.get(canon(o.phone));
    // alertKinds:[] = ownership WITHOUT switching on DMs. project.js line 46 takes the assignment's
    // alertKinds over the person's prefs whenever it is an array, so an empty one contributes no
    // alert kinds. These three people are already in their customer's group and see every ask
    // there; a brand-new DM stream to a real phone is a live noise change nobody asked for, and
    // it is trivially reversible later (set alertKinds:null to inherit their prefs).
    const a = await assignments.upsert({ personId: person.personId, customerId: cust, owner: true, enabled: true, alertKinds: [] });
    console.log(`ASSIGN  -> ${a.assignmentId} owner=${a.owner} alertKinds=[] (ownership only, no new DMs)`);
  }
  for (const { a } of plan.flagOwner) {
    const up = await assignments.upsert({ ...a, owner: true });
    console.log(`OWNER   -> ${up.assignmentId} owner=${up.owner}`);
  }
  console.log('\nDONE.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
