'use strict';
/**
 * UI-cohesion server surface: the account login contact.
 *
 * Boots the app (mock mode + memory store, no real boot()/listen) on an ephemeral port and drives
 * the reconnect flow over real HTTP. The invariant worth pinning is not "the phone round-trips" -
 * it is that storing it NEVER materializes a document for the implicit `primary` account.
 * `loadAccounts` returns an implicit primary only while the accounts collection is empty, so writing
 * the contact onto the account record would silently promote it to an explicit account. The contact
 * therefore lives in its own collection, and this test fails if anyone moves it back.
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const http = require('http');
const { app, store } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok ', m); } else { fail++; console.error('  FAIL -', m); } };

function req(method, url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(url);
    const headers = Object.assign(
      data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
      extraHeaders || {},
    );
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, json }); }); },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => req('GET', base + p);
  const post = (p, b) => req('POST', base + p, b, { origin: base }); // same-origin browser sim

  // --- 1. no contact before any reconnect ---------------------------------------------------
  let r = await get('/api/accounts');
  ok(r.status === 200, 'GET /api/accounts is 200');
  const primary = (r.json.accounts || []).find((a) => a.accountId === 'primary');
  ok(!!primary, 'the implicit primary account is listed');
  ok(primary.loginPhone === null, 'loginPhone is null before any reconnect');

  // --- 2. the phone is validated before an OTP is ever requested ----------------------------
  r = await post('/api/accounts/primary/reconnect/start', { phone: '12345' });
  ok(r.status === 400, 'a short phone is rejected with 400');
  r = await post('/api/accounts/primary/reconnect/start', { phone: '1812345671' });
  ok(r.status === 400, 'a phone not starting 6-9 is rejected with 400');

  // --- 3. mock reconnect stores the contact --------------------------------------------------
  r = await post('/api/accounts/primary/reconnect/start', { phone: '9812345671' });
  ok(r.status === 200 && r.json.ok, 'reconnect/start accepts a valid mobile');
  ok(/^\+91 XXXXXX5671$/.test(r.json.maskedPhone || ''), 'start returns a MASKED phone, never the full number');

  r = await post('/api/accounts/primary/reconnect/verify', { otp: '123456' });
  ok(r.status === 200 && r.json.ok, 'reconnect/verify accepts the mock code');

  r = await get('/api/accounts');
  const after = (r.json.accounts || []).find((a) => a.accountId === 'primary');
  ok(after.loginPhone === '+919812345671', 'loginPhone is stored canonically (+91XXXXXXXXXX)');

  // --- 4. THE invariant: primary stays implicit ----------------------------------------------
  const acctDocs = (await store.listDocs('accounts')) || [];
  ok(acctDocs.length === 0, 'storing the contact did NOT create an accounts doc (primary stays implicit)');
  ok(after.implicit === true, 'the primary account still reports itself implicit');

  const contactDocs = (await store.listDocs('accountContacts')) || [];
  ok(contactDocs.length === 1 && contactDocs[0].accountId === 'primary', 'the contact lives in its own collection');
  ok(!('token' in contactDocs[0]) && !('otp' in contactDocs[0]), 'the contact doc carries no secret material');

  // --- 5. a re-reconnect on a different number overwrites, not duplicates --------------------
  await post('/api/accounts/primary/reconnect/start', { phone: '9812345672' });
  await post('/api/accounts/primary/reconnect/verify', { otp: '999999' });
  const contactsAfter = (await store.listDocs('accountContacts')) || [];
  ok(contactsAfter.length === 1, 'a second reconnect overwrites the contact rather than adding one');
  ok(contactsAfter[0].phone === '+919812345672', 'the contact reflects the most recent login number');

  // --- 6. an expired/absent OTP session never writes a contact -------------------------------
  r = await post('/api/accounts/nosession/reconnect/verify', { otp: '123456' });
  ok(r.status === 410, 'verify without a live OTP session is 410');
  const stillOne = (await store.listDocs('accountContacts')) || [];
  ok(stillOne.length === 1, 'a failed verify stores no contact');

  // --- 6b. manual contact-set endpoint: email is independent of phone, neither clobbers the other
  r = await post('/api/accounts/primary/contact', {});
  ok(r.status === 400, 'an empty contact body (no phone, no email) is rejected with 400');
  r = await post('/api/accounts/primary/contact', { email: 'not-an-email' });
  ok(r.status === 400, 'an invalid email is rejected with 400');

  r = await post('/api/accounts/primary/contact', { email: 'ahmedabad@bestroadways.com' });
  ok(r.status === 200 && r.json.ok, 'a valid email alone is accepted');
  let contactDoc = await store.getDoc('accountContacts', 'primary');
  ok(contactDoc.email === 'ahmedabad@bestroadways.com', 'the email is stored');
  ok(contactDoc.phone === '+919812345672', 'setting the email did not clobber the already-stored phone');

  r = await post('/api/accounts/primary/contact', { phone: '9812345699' });
  ok(r.status === 200 && r.json.ok, 'a phone-only update after an email-only update still works');
  contactDoc = await store.getDoc('accountContacts', 'primary');
  ok(contactDoc.phone === '+919812345699', 'the phone is updated');
  ok(contactDoc.email === 'ahmedabad@bestroadways.com', 'setting the phone did not clobber the already-stored email');

  r = await get('/api/accounts');
  const withEmail = (r.json.accounts || []).find((a) => a.accountId === 'primary');
  ok(withEmail.loginEmail === 'ahmedabad@bestroadways.com', 'GET /api/accounts surfaces loginEmail');

  // --- 7. expectNew: a create must never overwrite an existing record ------------------------
  // The regression this pins: both stores upsert by a DERIVED natural key, so an "Add" whose key
  // collides used to silently overwrite the existing record. The console then reconciled coverage
  // against the new draft's EMPTY covers set and deleted every assignment the existing record had -
  // dropping the customer out of the additive bidding targets and out of alert routing, silently.
  await post('/api/customers', { label: 'Syngenta', aliases: ['Syngenta India'], margin: { marginsPct: [12, 8, 5], minMarginPct: 3 } });
  await post('/api/people', { personId: 'pankaj', name: 'Pankaj', phone: '+919812345671' });
  await post('/api/assignments', { personId: 'pankaj', customerId: 'syngenta' });

  r = await post('/api/customers', { label: 'Syngenta', expectNew: true });
  ok(r.status === 409, 'expectNew: re-adding an existing customer label is 409, not an overwrite');

  const syngenta = await store.getDoc('customers', 'syngenta');
  ok(syngenta && syngenta.margin && syngenta.margin.marginsPct.join(',') === '12,8,5', 'the refused create left the customer margin band intact');
  ok(syngenta.aliases.includes('Syngenta India'), 'the refused create left the customer aliases intact');
  ok(((await store.listDocs('assignments')) || []).length === 1, 'the refused create deleted no assignments');

  // A phone-derived personId collision is refused the same way.
  r = await post('/api/people', { name: 'Pankaj Again', phone: '+919812345672', expectNew: true });
  ok(r.status === 200, 'expectNew: a genuinely new mobile still creates a person');
  r = await post('/api/people', { name: 'Pankaj Typo', phone: '+919812345672', expectNew: true });
  ok(r.status === 409, 'expectNew: re-adding an existing mobile is 409, not an overwrite');

  // Without expectNew (the Edit path) an upsert still updates in place, as it must.
  r = await post('/api/customers', { customerId: 'syngenta', label: 'Syngenta', aliases: ['Syngenta India'], margin: { marginsPct: [11, 7], minMarginPct: 3 } });
  ok(r.status === 200, 'an edit (no expectNew) still updates in place');
  const edited = await store.getDoc('customers', 'syngenta');
  ok(edited.margin.marginsPct.join(',') === '11,7', 'the edit applied');
  ok(((await store.listDocs('assignments')) || []).length === 1, 'the edit deleted no assignments');

  // --- 8. one mobile belongs to one person ---------------------------------------------------
  // toRecipientRows dedupes recipients BY PHONE, so a second person on the same number would never
  // be sent anything. Reject the write rather than create that ghost.
  r = await post('/api/people', { personId: 'someone-else', name: 'Ghost', phone: '+919812345671' });
  ok(r.status === 409, 'a second person on an existing mobile is 409 even on the edit path');
  r = await post('/api/people', { personId: 'pankaj', name: 'Pankaj Renamed', phone: '+919812345671' });
  ok(r.status === 200, 'a person keeping their own mobile can still be edited');

  // --- 9. a recipient can never change KIND (person <-> WhatsApp group) -----------------------
  // The server-side backstop for the real misdelivery hazard: the console phone field digit-strips
  // whatever it holds, so re-saving a group row would turn '<digits>@g.us' into a valid stranger's
  // mobile while keeping the group's record - silently re-pointing a customer's whole alert stream.
  // Keyed off the STORED record's kind, so a group with a readable personId is still legal.
  const GROUP = '120363428871199271@g.us';
  r = await post('/api/people', { personId: 'grp-syn', name: 'BRL Bids - Syngenta', phone: GROUP });
  ok(r.status === 200, 'a WhatsApp group can be created as a recipient');
  const grp = await store.getDoc('people', 'grp-syn');
  ok(grp && grp.phone === GROUP, 'the group record stores the JID intact, not a digit-stripped number');
  r = await post('/api/people', { personId: 'grp-syn', name: 'Hijacked', phone: '+919812349999' });
  ok(r.status === 400, 're-pointing a group record at a mobile is refused (kind swap)');
  const still = await store.getDoc('people', 'grp-syn');
  ok(still.phone === GROUP, 'the refused kind-swap left the group JID intact');
  r = await post('/api/people', { personId: 'pankaj', name: 'Pankaj As Group', phone: GROUP });
  ok(r.status === 400, 're-pointing a person record at a group id is refused (kind swap, other direction)');

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
