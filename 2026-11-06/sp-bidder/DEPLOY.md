# Deploying the SuperProcure auto-bidder

This app runs on a shared VPS alongside other PM2 applications. The whole deployment is
designed so the two never touch: separate process, separate port, separate data, separate
reverse-proxy vhost. Follow the order below and the existing apps are never at risk.

**The one rule that prevents an outage:** operate this app BY NAME only.
`pm2 restart bid-command`, never `pm2 restart all`. PM2's `all`/global verbs hit every app
on the box.

---

## What runs where

| Piece                    | Where                              | Notes                                                                                                  |
| ------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Node app                 | `127.0.0.1:4103` (loopback)        | PM2 process `bid-command` (named in `ecosystem.config.cjs`). Not reachable from the internet directly. |
| Operator console (React) | served by the app at `/`           | Built to `dashboard/dist/`, served by Express. No separate process/port.                               |
| Legacy dashboard         | `/legacy`                          | Kept as a fallback view.                                                                               |
| Price-capture page       | `/price/<token>`                   | Public (the link is its own auth).                                                                     |
| Public entry             | reverse-proxy vhost on a subdomain | TLS terminates here; proxies to `127.0.0.1:4103`.                                                      |

The React console is **not** a second server. Vite builds it to static files; the app
serves them. In production there is one process and one port.

---

## 0. Pre-flight (read-only checks on the box)

```sh
pm2 list                 # note the existing apps - you will NOT touch them
ss -ltnp | grep -E ':4103|:80|:443'   # confirm 4103 is free; see what's on 80/443
free -m                  # RAM headroom for a second Node app
df -h /                  # disk headroom
nginx -T 2>/dev/null | grep -E 'server_name|listen' | head   # find the existing proxy + vhosts
```

If `4103` is taken, pick another free port and set `PORT` in `.env` and in the nginx
`upstream` block. If the front proxy is not nginx (e.g. Caddy/Apache), the same three
rules map over: loopback upstream, public `/price/`, basic-auth on everything else.

## 1. Build the console (on your machine, not the box)

```sh
npm run build:console    # installs dashboard deps + emits dashboard/dist/
```

Building locally keeps the prod box lean (no Vite/Tailwind devDeps installed there) and
makes the deploy deterministic. Ship the `dist/` artifact.

## 2. Ship the code

Use `scripts/deploy.sh` - it does this end-to-end. **Do not hand-roll an rsync/scp copy.**
The script builds the tarball from `git ls-files` (tracked files plus untracked-not-ignored
ones) and adds exactly two gitignored build artifacts by name, `version.json` and
`dashboard/dist/`. That keeps `node_modules`, `.env`, `data/`, the console source, and every
internal-only path off the box by construction, prunes internal copies left there by older
deploys, and refuses to ship if a check fails. A manual copy has none of those controls and
puts our own review/diagnosis notes on the client's machine.

The live box uses `/home/best-app/sp-bidder/` (we SSH as root - do not let `~` default you
into `/root`).

## 3. Install + configure (on the box)

```sh
cd /home/best-app/sp-bidder
npm install --omit=dev          # express, dotenv, socket.io-client, puppeteer-core
cp .env.example .env && chmod 600 .env
node scripts/hash-password.js   # prints SP_ADMIN_PASS_HASH=... (the plaintext is never stored)
nano .env                       # PLATFORM=real, SP_TOKEN=<jwt>, SP_BASE_URL=https://bidder.<domain>,
                                #   SP_ADMIN_USER, SP_ADMIN_PASS_HASH=<from above>, SP_SESSION_SECRET=<openssl rand -hex 32>,
                                #   SP_BOOT_LIVE=1 to boot LIVE (omit for the dry-run default + manual "Go live")
mkdir -p data/logs
```

Secrets live ONLY in this `.env` (chmod 600, gitignored). Never commit a token.

**Real mode refuses to boot without `SP_ADMIN_PASS_HASH` and `SP_SESSION_SECRET`** - the operator
login gate is mandatory before any real-money console is exposed. Keep `SP_SESSION_SECRET` stable
(a changed secret logs everyone out on the next restart).

### Desk cost floor (clerical-error guard)

Every cost entry refuses a rate below a floor, so a missing digit (1,500 typed for a load meant to
be 15,000) cannot arm the engine. Two surfaces enter a cost and the floor covers **both**: the
desk's public `/price` submit (first capture and re-price) and the console's margin re-price
(`POST /api/price-requests/:id/margin`), which rebuilds the whole ladder on a live auction off the
new number. Unlike the older soft guard it is a refusal, not a confirm - nothing in either page
bypasses it, no ack or confirm opens it, and the server re-checks every submit.

| Var                  | Default | What it does                                                                                                                                  |
| -------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `SP_MIN_COST_ABS`    | `5000`  | Absolute per-load minimum, in Rs.                                                                                                             |
| `SP_MIN_COST_PER_KM` | `10`    | Per-km minimum in Rs, multiplied by SuperProcure's own route distance for that load. A load with no distance on the wire gets no per-km term. |

The effective floor is the **higher** of the two: `max(abs, perKm x km)`. Either knob at `0`
disables that term; **both at `0` disables the hard floor entirely** and restores the previous
soft-confirm-only behaviour exactly. TRUCK basis only - a PMT ("Quote Per MT") load is quoted per
metric tonne, where Rs 800 is a real rate, so the floor is skipped there and only the soft confirm
applies.

Both are read from `.env` **at process start**, not from the console. Retuning them means editing
`.env` and running `pm2 restart bid-command` - which also re-arms every open auction from disk, so
do it deliberately, not mid-close-window. The values in force are printed in the boot log
(`pm2 logs bid-command`) on every start, so a typo is visible at restart:

```
[bid-command] desk cost floor: abs Rs 5000, per-km Rs 10/km (whichever is higher; TRUCK basis only, PMT exempt)
```

The console's Settings page carries a **Missing-digit check** (`clericalFloor { absRs, perKmRs }` in
the config store), unset by default. While unset the two env knobs above apply. Once set it replaces
them, with the terms ADDED rather than maxed: `absRs + perKmRs x km` (Rs 3,000 + Rs 9/km on a 620 km
lane is Rs 8,580). A save takes effect on the next request with no restart and survives one; "Use
default" clears it. On a load priced per truck type, the floor binds each type's rate, not the blend.

Every refusal is logged as a `cost floor REFUSED` warn line and appended to the `costFloorRefused`
event stream under `data/`, so "is it catching anything?" is answerable after the fact. Both
surfaces write to that one stream, and each record carries `source` (`price-submit` or
`margin-route`) plus `actor`, so a refusal spike can be split by which seam produced it and who was
behind it - a mistyped knob refusing every submit, the desk fat-fingering the public link, and one
operator pushing a low cost through the console all look identical in a bare count. The
price-request capability token is redacted to a short prefix in that record (it is the auth for the
public `/price` link, and this stream lands on disk and in backups) - correlate on `loadId`.

### Notifications (WhatsApp, optional)

Out of the box the console worklist + History are the notification surface (no external dependency).
To also send WhatsApp alerts (the GoComet-style price-needed / bid-live / outbid / won / lost / error
events), use Maytapi - the provider BRL already runs for GoComet. It needs no Meta template approval;
the bidder renders each alert and sends it as plain text.

Add to `.env`: `SP_WHATSAPP_ENABLED=1`, `SP_MAYTAPI_TOKEN=<token>`, `SP_MAYTAPI_PRODUCT_ID=<product id>`,
`SP_MAYTAPI_PHONE_ID=<linked sender phone id>` (from BRL's Maytapi console; the phone id picks which
linked number the alerts go out from - list them via Maytapi's listPhones). Then set notify mode to
`whatsapp` (Notifications tab, or `SP_NOTIFY_MODE=whatsapp`) and add recipients on the **Team** page
with the alert kinds each should receive, then assign them to customers on **Assignments** to scope
routing. All of enabled+token+productId+phoneId must be present or it stays on the dashboard channel.
Dedupe is restart-safe and bounded; sends never block or fail an operator action.

**Remove `SP_MAYTAPI_SENDER_NUMBER` from `.env` if it is still there.** Nothing reads it. It used to
declare the one MSISDN the sender slot was allowed to be on, and the monitor
(`scripts/monitor-wa-sender.js`, cron) alarmed on anything else. BRL runs several handsets on one
Maytapi product and moves the sender between them, so that alarmed on every legitimate swap, and its
only remedy was to come back and re-type the declaration. On 2026-09-22 the slot was re-linked to
BRL's original handset while the pin still held the number used during the previous week's outage:
35 hours of urgent alarms on three tiers, every 30 minutes, naming BRL's own phone as an intruder and
telling the reader to unlink the one working handset.

**What replaced it DOES have a deploy step: the sender's own number must be on the staff allowlist.**
The monitor now asks whether the new number is one of BRL's, answering from the other slots on BRL's
own Maytapi product plus `data/staffRoster.json` - the same file the daily group tripwire maintains.
A move inside that set is a one-line email notice and the number is adopted, so it is said once. A
move outside it keeps the full alarm on every tier, is never adopted, and the re-link page refuses to
hand out a pairing code while it stands.

The board half **excludes the slot being checked** - after a re-bind its number is whatever just
captured it, so counting it would let any phone authorise itself. That means the bidder's own handset
can only enter the set via the allowlist, and nothing else will put it there. Check it before
deploying:

```bash
grep -c '"' data/staffRoster.json                 # sanity: the file parses and is non-empty
grep '<the sender slot MSISDN>' data/staffRoster.json   # must match
```

If it is missing, every recovery alert is hedged with "not on BRL's list" naming BRL's own number,
and the next swap back to that handset raises the full alarm. Same for any other handset BRL
actually runs: absent from the allowlist reads as a stranger.

**The allowlist is a security boundary now, not just group hygiene.** It is 47 personal staff
mobiles, so anyone on it who scans the re-link QR on their own phone is reported as a routine swap
and adopted rather than alarmed. That exposure was weighed and accepted (Sid, 2026-09-23) in exchange
for not maintaining a second list; the consequence is that adding someone to `staffRoster.json` now
also grants them the ability to silently become BRL's outbound WhatsApp.

**Alerts are only ever sent from the bidder's own slots.** `MONITOR_ALERT_FROM_PHONES` defaults to
`128023,136151`. BRL's product holds seven slots and most are sales lines; the sibling picker used to
take the first active slot in board order, which is a sales number, and on 2026-09-23 the director
asked why bidder alerts were arriving from it. If both those slots are down the WhatsApp tier goes
quiet and email carries the alert, which is the deliberate trade - sending from the wrong identity is
worse than sending on one channel.

**Set `HEALTHCHECK_URL` too, on the same pass.** It is a dead-man's-switch ping (healthchecks.io or
equivalent) and it is the only off-box carrier for two things the box cannot report about itself: a
dead box or dead cron, which stops the pings and lets the external service raise the alarm; and the
per-run `baseline=` / `qr=` fields, which say whether the wrong-phone check has a number on record
(`baseline=ok`) or nothing to compare against yet (`baseline=none`).

### Director end-of-day participation DM (optional, OFF until configured)

After the per-customer group EODs, the directors can get one cross-customer participation
summary by direct message: of every load surfaced that day, how many got a bid.

Add to `.env`: `SP_DIRECTOR_EOD_RECIPIENTS=<comma-separated numbers in full international form>`.
**That list is the on-switch** - there is no separate enable flag, and an empty or unset value
means the feature stays dark and nothing is ever sent. That is deliberate (it DMs named humans
by raw number, so silence is the safe default), but it also means a box that never sets this var
runs the feature permanently inert with no error - if the directors are not receiving the
evening DM, check this var first. Optionally set `SP_DIRECTOR_EOD_TIME_IST` (default `20:10`,
IST regardless of the box's timezone) to move the slot. WhatsApp must be configured above for
anything to actually send.

## 4. Start under PM2 (scoped to this app)

```sh
pm2 start ecosystem.config.cjs           # starts ONLY bid-command (the file declares just it)
pm2 list                                 # confirm bid-command is online AND all prior apps still online
pm2 save                                 # persist the process list for reboot
```

`PLATFORM` comes from the on-box `.env`, not the ecosystem file (absent = mock, the
fail-safe). On redeploys use a plain `pm2 restart bid-command` - never `pm2 startOrReload
ecosystem.config.cjs`, which re-applies ecosystem env over the running process's env.

Run `pm2 save` ONLY after confirming every pre-existing app is still `online` in `pm2 list`

- `pm2 save` snapshots the current list, so saving while another app is down de-registers it.

A restart re-arms live auctions from disk (the durable scheduler), with a loud warning either
way: in DRY-RUN by default (never silently resumes a real bid), or LIVE when `SP_BOOT_LIVE=1`.

## 5. Reverse proxy + TLS

```sh
# websocket upgrade map (once, if not already present in http{}):
sudo cp deploy/nginx/map-connection-upgrade.conf /etc/nginx/conf.d/

# basic-auth file for the console (outside any repo):
sudo apt-get install -y apache2-utils
sudo htpasswd -c /etc/nginx/.sp-bidder.htpasswd opsuser

# the vhost (edit server_name to your subdomain first):
sudo cp deploy/nginx/bidder.conf /etc/nginx/sites-available/sp-bidder.conf
sudo ln -s /etc/nginx/sites-available/sp-bidder.conf /etc/nginx/sites-enabled/

sudo certbot --nginx -d bidder.<domain>  # issue the TLS cert
sudo nginx -t && sudo systemctl reload nginx   # RELOAD (graceful), never restart
```

Point DNS `bidder.<domain>` -> the server IP before running certbot.

**Two auth layers, by design.** nginx Basic auth is the OUTER wall (one shared credential);
the app's own operator login is the INNER gate (per-session, with logout + the config-change
audit trail). Keep both until the app login is proven in live use, then you may drop the nginx
Basic auth on the console/API (the app gate becomes the sole login) - `/price/` stays public
either way. The app binds loopback regardless, so nginx is always the only way in.

## 6. Smoke test (deep, not just a 200)

1. `https://bidder.<domain>/` -> console loads; nginx basic-auth prompt, then the app login screen.
2. `https://bidder.<domain>/api/state` -> `401` until you log in; after login, JSON with `mode: "real"` and `live: false` (DRY-RUN), or `live: true` when `SP_BOOT_LIVE=1`.
3. Paste a token into the console's Connect box -> `/api/live-state` returns live loads (read-only).
4. Open a real `/price/<token>` link from a phone (no login) -> the cost form renders and submits.
5. **Open `/api/wa/relink-qr` from a phone that has never visited the console, and confirm BOTH
   credential prompts are passable** with credentials the `MONITOR_ALERT_TO` recipients actually
   hold - the browser's nginx Basic-auth popup first, then the app login. This is the deep-link the
   sender-down alert sends to a personal phone at 2am; a recipient who holds only one of the two
   credentials discovers it during the outage and falls back to the Maytapi console.
6. **Against an idle or spare slot, confirm a second handset can actually SCAN the QR off the
   page.** Open `/api/wa/relink-qr` on a phone, then on another phone do WhatsApp > Linked Devices >
   Link a Device pointed at the on-screen code. This is the one thing no automated tier can cover:
   the tests prove the endpoint returns PNG-signed bytes and that the page branches correctly, not
   that a ~6 KB QR rendered into a ~288px box on a phone screen is still machine-readable. It is the
   same acceptance bar `scripts/probe-sender-qr.js` sets for the push leg - and unlike that leg, this
   one ships **enabled with no flag**, so it is the layer most likely to be discovered broken by the
   person least able to absorb it. Record the outcome in `renderRelinkQrPage()`'s header in
   `scripts/lib/sender-qr.js`, the way `sendQrImage()`'s header records the send leg.
7. Confirm the engine arms a discovered load in DRY-RUN (emits what it WOULD bid, places nothing).
8. Only after sign-off: one supervised, gated, can't-win bid on a low-stakes hard-close load to
   prove the write path - then back to DRY-RUN.

The other apps on the box are untouched throughout: `pm2 list` should show them with the same
uptime as before you started.

---

## Release provenance (guard + tag + version.json)

Every deploy is guarded, tagged, and stamped, so "what is live" is always traceable to a commit
and a release - never guesswork.

```sh
sh scripts/deploy.sh            # patch bump (default - the safe under-claim)
sh scripts/deploy.sh minor      # a feature deploy
sh scripts/deploy.sh major      # module acceptance / default-behavior change (type it deliberately)
```

**Pre-flight guard** (`scripts/deploy-guard.sh`, runs before anything is built or shipped). The
tarball ships the working tree, so the guard hard-REFUSES the deploy unless all three hold:
`main` is checked out (held work lives off main on purpose), the working tree is clean (modified,
staged, AND untracked files all land in the tarball - this is what stops stray `debug-*.js`
scratch files reaching prod), and local `main` matches `origin/main` after a fetch. Escape hatch:
`DEPLOY_UNSAFE=1 sh scripts/deploy.sh` overrides with a loud multi-line warning, skips the tag,
and stamps `dirty:true` (version `dev`) into version.json so the box records it is not on a clean
release. Emergency only; redeploy clean afterwards.

**Tag-at-deploy.** On a clean deploy the script computes the next semver from the latest `v*` tag,
shows the current version + last tag, and lets you confirm or override the exact tag before it
creates an annotated tag at HEAD and pushes it. Pick the bump in ~10 seconds:

- MAJOR (`x+1.0.0`) - a module is accepted/switched on as the new baseline, the bot's default
  bidding behavior changes, or a migration breaks rollback. Gut check: "I'd message Suyashh first."
- MINOR (`x.y+1.0`) - any new capability (a `feat:` PR), even flagged/off. "Earns a weekly bullet."
- PATCH (`x.y.z+1`) - fixes/perf/refactor/chore/docs/ci only. "Nobody outside the repo needs to know."

The first guarded deploy baselines `v1.0.0` regardless of content (Module 1 is live in prod).

**version.json + /api/version (the what's-live check).** deploy.sh stamps version.json into the
tarball; the server reads it at boot, prints a one-line banner
(`[bid-command] version=v1.0.0 sha=<short> built=<iso>`) to `pm2 logs bid-command`, and
serves it at the authed `GET /api/version` (behind the operator login, same gate as /api/state).
An absent stamp (dev checkout) reports `version: "dev"` and never blocks boot. Answer "exactly
what is live":

```sh
sh scripts/ssh-vps.sh 'cat /home/best-app/sp-bidder/version.json'   # ground truth on the box
```

## Weekly release ritual (~12 min, Friday EOD or the last deploy of the week)

1. Confirm what's live: `version.json` on the box matches the latest tag.
2. If you deployed today, the guarded deploy already created the tag. No deploy this week -> no
   tag (semver tags ship only with deploys).
3. Publish the GitHub Release on the week's latest tag:
   ```sh
   GH_TOKEN=$(gh auth token -u dorddis) gh release create v1.0.0 --generate-notes \
     -t "Week 29 (Jul 13-17): <one-line theme>"
   ```
   `--generate-notes` builds "What's Changed" from the merged PR titles since the last release.
4. Edit the release: prepend `## This week` (3-5 plain, logistics-director bullets - the same
   bullets feed the Suyashh weekly update) and a `## Deployed` line (tag/sha live on the box + date).
5. Mid-week hotfix deploy: it tags at deploy (that IS the patch bump); publish its release right
   then rather than batching to Friday, so the record never lags the box.
6. No-deploy week with merges: no tag; one STATUS line ("merged, NOT deployed - box on v1.0.0");
   the merged work lands in the next deploy's generated notes automatically.

Milestone releases (`module-<N>-delivery`) are unchanged - they stay the client-facing summary
layer and point at the same commit as the matching `vN.0.0` tag; Suyashh sees milestone language,
never version numbers.

**Verifying the guard:** `node scripts/test-deploy-guard.js` exercises the refuse/allow conditions
and the version bumps against throwaway git repos. It needs `sh` + `git` spawnable (Git Bash
locally, or CI) and skips cleanly where they are not. By hand: on a dirty or non-main checkout,
`sh scripts/deploy.sh` must refuse before it builds anything.

## Adding a second SP account (two-account auth routing)

Accounts are data, not code - the app boots one full bidding stack (adapter + engine +
discovery + socket) per enabled account, and with none configured it runs the single
SP_TOKEN account exactly as before. To add an account, all you need is its token:

```sh
cd /home/best-app/sp-bidder
# 1. validate first (read-only login + one auctions list; writes nothing, never bids):
node scripts/add-account.js --dry-run --token '<that account's jwt>'
# 2. same command without --dry-run writes the account record (data/accounts.json).
#    It stores only the env-var NAME (default SP_TOKEN_2) - never the token itself.
node scripts/add-account.js --token '<that account's jwt>'
# 3. add the token to the on-box .env (chmod 600), matching the tokenEnv the script printed:
#        SP_TOKEN_2=<the jwt>
# 4. restart BY NAME - the new account connects on boot:
pm2 restart bid-command
```

Verify: `pm2 logs bid-command` shows one `[real:<id>] logged in` line per account, and the
console's Settings page lists each account with its connection state and token expiry.

Notes:

- carrierId/branchIds are derived from the token at login and cached on the record -
  never type them in. Optional flags: `--id <slug>`, `--label '<name>'`, `--token-env <NAME>`.
- Scoping: by default every account uses the global Bidding targets allowlist. To split
  shippers between accounts, set an `allowlist` object on that account's record in
  data/accounts.json (same shape as the global one: shippers/lanes/hardCloseOnly).
- If two enabled accounts can see the same shipper, boot logs a LOUD overlap warning;
  a load both can see gets exactly ONE price request (the first enabled account owns it).
- The kill switch, go-live gate and DRY-RUN default apply to ALL accounts at once -
  one kill stops everything.
- Live Bids / History / Price Requests grow an "Account" column automatically once
  more than one account exists; with a single account the console is unchanged.

## Operating it (day-to-day)

```sh
pm2 restart bid-command    # after a redeploy
pm2 logs bid-command       # tail logs (this app only)
pm2 stop bid-command       # pause
pm2 describe bid-command   # status, restarts, memory
```

Never `pm2 restart all`, `pm2 reload all`, or `pm2 delete all` - they hit every app on the box.

## Redeploy

Rebuild the console (step 1), ship (step 2), then on the box `npm install --omit=dev` if deps
changed and `pm2 restart bid-command`. The reverse proxy and `.env` stay as they are.

## Rollback

`pm2 stop bid-command` removes the app from service immediately; the proxy then returns 502 for
its subdomain only. Nothing else on the box is affected. Redeploy the prior version and
`pm2 restart bid-command` to restore.
