'use strict';

// resolveOwners + mentionToken - the PURE half of @-mention routing (no store, no I/O, no wire).
// These two functions decide WHO gets tagged on a load and WHAT token renders for them; the
// notifier/template wiring on top is deliberately thin, so this is where the feature is actually
// pinned. Every case below is a way the tag could go to the wrong person, tag nobody, tag a GROUP,
// or render a malformed token into a live customer group.

const assert = require('assert');
const { resolveOwners, mentionToken } = require('../src/model/resolve');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log('  ok  ' + m); };

// --- fixtures: shaped exactly like the real stores emit -------------------------------------
const CUSTOMERS = [
  { customerId: 'borosil', label: 'Borosil', aliases: ['Borosil'], enabled: true },
  { customerId: 'syngenta', label: 'Syngenta', aliases: ['Syngenta'], enabled: true },
  { customerId: 'dormant', label: 'Dormant Co', aliases: ['Dormant'], enabled: false },
];
const SAMEER = { personId: 'p919594963428', name: 'Sameer Ambadaskar', phone: '+919594963428', enabled: true };
const PAVAN = { personId: 'p919090707777', name: 'Pavan Konda', phone: '+919090707777', enabled: true };
// A group is modelled as a person-record whose phone is a JID - the trap resolveOwners must dodge.
const GROUP = { personId: 'g120363410658010519', name: 'BRL Bids - Borosil', phone: '120363410658010519@g.us', enabled: true };
const PEOPLE = [SAMEER, PAVAN, GROUP];
// Default owner:true in the helper so each test states its OWN subject; the owner gate itself is
// pinned explicitly in section 9 (and it is what real, undesignated production data looks like).
const A = (personId, customerId, extra = {}) => ({ assignmentId: `${personId}::${customerId}`, personId, customerId, enabled: true, owner: true, ...extra });

console.log('\n=== 1. resolveOwners - the happy path ===');
{
  const owners = resolveOwners({
    companyName: 'BG (BorosilLimited(Govindgarh))',
    customers: CUSTOMERS, people: PEOPLE,
    assignments: [A('p919594963428', 'borosil'), A('g120363410658010519', 'borosil')],
  });
  ok(owners.length === 1, 'a load resolves to exactly its customer-assigned human');
  ok(owners[0].personId === 'p919594963428', 'and it is the right person');
  ok(owners[0].phone === '+919594963428', 'the stored phone comes back untouched for the token layer');
  ok(owners[0].name === 'Sameer Ambadaskar', 'the name rides along for logging and Owner-line copy');
}

console.log('\n=== 2. the GROUP-JID exclusion (would otherwise @-mention the group inside itself) ===');
{
  const owners = resolveOwners({
    companyName: 'Borosil', customers: CUSTOMERS, people: PEOPLE,
    assignments: [A('g120363410658010519', 'borosil')],
  });
  ok(owners.length === 0, 'a customer whose ONLY assignment is its group resolves to no mention target');
}

console.log('\n=== 3. every "no owner" path returns [] (never throws, never a partial) ===');
{
  const base = { customers: CUSTOMERS, people: PEOPLE, assignments: [A('p919594963428', 'borosil')] };
  ok(resolveOwners({ ...base, companyName: 'Totally Unknown Shipper' }).length === 0, 'no customer match -> []');
  ok(resolveOwners({ ...base, companyName: 'Syngenta' }).length === 0, 'customer matched but nobody assigned -> []');
  ok(resolveOwners({ ...base, companyName: 'Dormant' }).length === 0, 'a DISABLED customer never resolves owners');
  ok(resolveOwners({ companyName: 'Borosil', customers: CUSTOMERS, people: PEOPLE, assignments: [] }).length === 0, 'no assignments at all -> []');
  ok(resolveOwners({ companyName: 'Borosil', customers: CUSTOMERS, people: [], assignments: [A('p919594963428', 'borosil')] }).length === 0, 'assignment pointing at a person who does not exist -> [] (no crash)');
  ok(resolveOwners({ companyName: '', customers: CUSTOMERS, people: PEOPLE, assignments: [] }).length === 0, 'empty companyName -> []');
  ok(resolveOwners({ companyName: 'Borosil', customers: null, people: null, assignments: null }).length === 0, 'all-null collections -> [] (no crash)');
  ok(resolveOwners({ companyName: 'Borosil', customers: CUSTOMERS, people: PEOPLE, assignments: [null, undefined] }).length === 0, 'junk rows in assignments are skipped');
}

console.log('\n=== 4. disabled records are excluded ===');
{
  const off = { personId: 'p910000000001', name: 'Left The Company', phone: '+910000000001', enabled: false };
  const owners = resolveOwners({
    companyName: 'Borosil', customers: CUSTOMERS, people: [...PEOPLE, off],
    assignments: [A('p910000000001', 'borosil'), A('p919594963428', 'borosil', { enabled: false })],
  });
  ok(owners.length === 0, 'a disabled PERSON and a disabled ASSIGNMENT are both excluded');
}

console.log('\n=== 5. wrong-customer isolation ===');
{
  const owners = resolveOwners({
    companyName: 'Borosil', customers: CUSTOMERS, people: PEOPLE,
    assignments: [A('p919090707777', 'syngenta'), A('p919594963428', 'borosil')],
  });
  ok(owners.length === 1 && owners[0].personId === 'p919594963428', "a person assigned to ANOTHER customer is never tagged on this one");
}

console.log('\n=== 6. dedupe + deterministic order (golden-output safety) ===');
{
  const dupe = { personId: 'p919594963428', name: 'Sameer (dupe row)', phone: '919594963428', enabled: true };
  const owners = resolveOwners({
    companyName: 'Borosil', customers: CUSTOMERS, people: [...PEOPLE, dupe],
    assignments: [A('p919594963428', 'borosil'), A('p919594963428', 'borosil', { assignmentId: 'second::borosil' })],
  });
  ok(owners.length === 1, 'two assignments for one human produce ONE mention, not two');

  const many = [A('p919090707777', 'borosil'), A('p919594963428', 'borosil')];
  const fwd = resolveOwners({ companyName: 'Borosil', customers: CUSTOMERS, people: PEOPLE, assignments: many });
  const rev = resolveOwners({ companyName: 'Borosil', customers: CUSTOMERS, people: PEOPLE, assignments: many.slice().reverse() });
  ok(fwd.length === 2, 'two distinct owners both resolve');
  ok(JSON.stringify(fwd) === JSON.stringify(rev), 'order is stable regardless of assignment input order');
  ok(fwd[0].personId < fwd[1].personId, 'and it is sorted by personId, so rendered text is reproducible');
}

// Section 7 is pinned by a LIVE probe (test group, 2026-07-25, eyeballed in the WhatsApp client):
// the country-coded token resolved to the participant's display name and pinged them, while the
// bare 10-digit form did NOT resolve - it rendered as raw digits and notified nobody. So the
// country code is load-bearing, and a "tidy-up" that strips it would silently stop tagging people
// while still returning success:true from Maytapi. That is what these assertions guard.
console.log('\n=== 7. mentionToken - the Maytapi wire format (probe-verified) ===');
{
  ok(mentionToken('+919594963428') === '@919594963428', 'stored +91 form -> @91 token (country code KEPT, + stripped)');
  ok(mentionToken('+919594963428').length === 13, 'the token keeps all 12 digits + the @ - a stripped country code would not resolve');
  ok(mentionToken('919594963428') === '@919594963428', 'an already-bare country-coded number is unchanged');
  ok(mentionToken('+91 95949 63428') === '@919594963428', 'spaces are stripped');
  ok(mentionToken('') === '', 'empty phone yields NO token (never a bare "@")');
  ok(mentionToken(null) === '', 'null yields no token');
  ok(mentionToken(undefined) === '', 'undefined yields no token');
  ok(mentionToken('not-a-number') === '', 'a non-numeric record yields no token, never "@" alone');
  ok(!mentionToken('+919594963428').includes('+'), 'the token never carries a + (Maytapi would not parse it)');
  ok(!mentionToken('+919594963428').includes('@c.us'), 'the token is NOT a JID - no @c.us suffix');
}

console.log('\n=== 8. end-to-end shape: owners -> tokens ===');
{
  const owners = resolveOwners({
    companyName: 'BG (BorosilLimited(Govindgarh))', customers: CUSTOMERS, people: PEOPLE,
    assignments: [A('p919090707777', 'borosil'), A('p919594963428', 'borosil'), A('g120363410658010519', 'borosil')],
  });
  const tokens = owners.map((o) => mentionToken(o.phone)).filter(Boolean);
  ok(tokens.length === 2, 'the group is dropped; both humans produce a token');
  ok(tokens.join(' ') === '@919090707777 @919594963428', 'the rendered token string is exact and stable');
  ok(!tokens.join(' ').includes('g.us'), 'no group JID can ever reach the rendered message');
}

console.log('\n=== 9. the OWNER gate - an alert-recipient is NOT a desk owner ===');
{
  // The live-data shape this gate exists for: the Director carries an assignment to nearly every
  // customer for oversight. Without the gate he is tagged on every single load of every customer.
  const director = { personId: 'p919594937777', name: 'Suyashh Gupta', phone: '+919594937777', enabled: true };
  const peopleWithDirector = [...PEOPLE, director];
  const assignments = [
    { assignmentId: 'p919594937777::borosil', personId: 'p919594937777', customerId: 'borosil', enabled: true }, // no owner key at all
    A('p919594963428', 'borosil'), // the real desk owner
  ];
  const owners = resolveOwners({ companyName: 'Borosil', customers: CUSTOMERS, people: peopleWithDirector, assignments });
  ok(owners.length === 1, 'an oversight assignee (no owner flag) is NOT tagged');
  ok(owners[0].personId === 'p919594963428', 'only the designated desk owner is tagged');

  const explicitFalse = [{ assignmentId: 'x::borosil', personId: 'p919594963428', customerId: 'borosil', enabled: true, owner: false }];
  ok(resolveOwners({ companyName: 'Borosil', customers: CUSTOMERS, people: PEOPLE, assignments: explicitFalse }).length === 0, 'owner:false is excluded');

  for (const truthy of ['true', 1, 'yes', {}]) {
    const loose = [{ assignmentId: 'x::borosil', personId: 'p919594963428', customerId: 'borosil', enabled: true, owner: truthy }];
    ok(resolveOwners({ companyName: 'Borosil', customers: CUSTOMERS, people: PEOPLE, assignments: loose }).length === 0,
      `a merely-truthy owner value (${JSON.stringify(truthy)}) does NOT designate an owner - strict === true only`);
  }
}

console.log('\n=== 10. validateAssignment persists the owner flag, defaulting OFF ===');
{
  const { validateAssignment } = require('../src/model/assignmentStore');
  const base = { personId: 'p1', customerId: 'c1' };
  ok(validateAssignment(base).owner === false, 'an assignment with no owner key defaults to owner:false (every existing record)');
  ok(validateAssignment({ ...base, owner: true }).owner === true, 'owner:true round-trips through validation');
  ok(validateAssignment({ ...base, owner: false }).owner === false, 'owner:false round-trips');
  ok(validateAssignment({ ...base, owner: 'true' }).owner === false, 'a string "true" is NOT accepted as ownership');
  ok(Object.prototype.hasOwnProperty.call(validateAssignment(base), 'owner'), 'the field is always present, so the shape is stable on disk');
}

console.log(`\n${pass} passed, 0 failed`);
