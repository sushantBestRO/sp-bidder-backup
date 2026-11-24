# Runbook: capture a fresh SuperProcure token (email login + account selection)

Written 2026-08-04 after the token-revocation outage. Use this whenever an account reports
`auth_failed_401` / `Token is invalid.` and has to be re-logged-in.

Currently dead and needing this: **primary (carrier 10686)**, **sameer-ambdaskar (4441)**,
**neemrana (33732)**. Master (2667) was restored 2026-08-04 13:42 IST.

---

## What the login flow actually is

Three POSTs, all on `https://auth-api.superprocure.com`. Captured live 2026-08-04.

1. `POST /api/v1/auth/email`
   body: `{"email":"<address>"}`
   returns: `{"data":{"id":"<session id>"}}` and emails a 6-digit OTP.

2. `POST /api/v1/auth/validate/otp`
   body: `{"id":"<session id>","otp":"<6 digits>","ssoLogin":"","redirectUrl":"https://app.superprocure.com/loadBoard?tab=open","selection":null}`
   returns **one of two things**:
   - a token, if the login maps to exactly one SP account, or
   - `{"data":{"accounts":[ ... ]}}` - the account picker. Each entry carries its own
     `selection` JWT plus `id`, `username` and `description`.

3. `POST /api/v1/auth/validate/otp` again, same `id` and same `otp`, but
   `"selection":"<that account's selection JWT>"`
   returns: `{"data":{"token":"<the bearer JWT>"}}` - valid **365 days**.

The bearer token is what the bidder needs. Nothing else from the flow is used.

**Phone login is the same flow** with `POST /api/v2/auth/phone` `{phone,countryCode}` in place of
step 1.

## The catch that matters

`selection` JWTs expire about **15 minutes** after the OTP is validated. The `id` + `otp` pair can
be re-POSTed more than once inside that window (proven: the real capture did exactly that), so one
OTP can mint tokens for several accounts, but only if you move quickly.

**Unverified:** the picker on `bidding@bestroadways.com` offered three accounts - u_id 43039
(= master, carrier 2667), u_id 2569 (parent 1814) and u_id 32468 (parent 91035). Only 43039 was
minted, so we do **not** know whether 2569/32468 are primary/sameer/neemrana or unrelated entities.
2569 sits under a different parent company than master, so do not assume it. Mint each one and read
the carrier id back before installing anything.

---

## Path A - fastest, one OTP for several accounts (needs someone comfortable in DevTools)

1. Chrome, open `https://app.superprocure.com`. F12 > Network. Tick **Preserve log**. Filter Fetch/XHR.
2. Log in with email. Enter the OTP from the inbox.
3. When the account picker appears, pick the first account you need.
4. Right-click the second `validate/otp` request > **Copy > Copy as fetch**.
5. Paste into the Console, change `selection` to the next account's `selection` value (read it out of
   the picker response in step 3), run it. The response carries that account's token.
6. Repeat step 5 for each remaining account. All of it must happen inside ~15 minutes.
7. Right-click anywhere in Network > **Save all as HAR with content**. Send Sid the .har file.

## Path B - simplest, no DevTools skill needed

One login per account, repeated:

1. Chrome, `https://app.superprocure.com`, F12 > Network, tick **Preserve log**.
2. Log in with that account's email or phone, enter the OTP, pick the account on the picker page.
3. Wait for the load board to render.
4. Network panel > right-click > **Save all as HAR with content**.
5. Send Sid the .har. Repeat from step 1 for the next account.

Slower (one OTP each) but nothing can go wrong.

---

## Installing the token (Sid)

Never paste a token into chat, a ticket, or a commit.

1. Pull the bearer out of the HAR: it is `data.token` on the **last** `validate/otp` response.
2. Verify what it actually is before installing - the HAR's `getAvailableViews` reports
   `companyInfo.carrierId` as the **company**, not the carrier. Only the adapter's own `login()`
   resolves the real carrier id:

   ```
   node -e 'const fs=require("fs");const t=fs.readFileSync("/tmp/sp_new_token","utf8").trim();
   const c=require("./src/config");const {RealSuperProcureAdapter}=require("./src/platform/realAdapter");
   new RealSuperProcureAdapter({token:t,headers:c.capturedHeaders}).login()
     .then(a=>console.log(a.carrierId,a.company,a.branchIds.length))'
   ```

   Match `carrierId` against `data/accounts.json` to find the account, and its `tokenEnv`.
   Installing a token under the wrong `tokenEnv` breaks a working account - the console's own
   reconnect route refuses a carrier mismatch for exactly this reason, so check by hand here.
3. Back up `data/secrets.json`, then write it with the app's own vault (atomic + chmod 600):

   ```
   node -e 'const fs=require("fs");const {SecretsVault}=require("./src/store/secretsVault");
   new SecretsVault({dataDir:"data"}).set("<TOKEN_ENV>", fs.readFileSync("/tmp/sp_new_token","utf8").trim())'
   ```

4. `pm2 restart bid-command` - by name only, never `all`, never an ecosystem reload. The vault is
   read once at boot (`applyToEnv`), and it wins over `.env`.
5. Confirm: `login succeeded` for that carrier in the log, then no further `Token is invalid.`, then
   a `bid_placed` on the next load that reaches its close.
6. `rm /tmp/sp_new_token`.

## Known gap this exposed

`src/auth/spOtpAuth.js` posts `selection: null` and expects a token straight back, so the console's
self-serve reconnect **cannot complete for any login that maps to more than one SP account** - it
gets the picker payload and fails to extract a token. It is also phone-only; there is no email path.
Fixing both (email login + handling the picker) is the tracked follow-up that would make this runbook
unnecessary.
