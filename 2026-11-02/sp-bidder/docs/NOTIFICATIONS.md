# Notifications

How the bidder tells your team what's happening, and how to turn on WhatsApp delivery.

## Channels

Two delivery channels, switchable on the **Notifications** tab:

- **WhatsApp** (default): alerts are sent to recipients' phones via Maytapi (the same WhatsApp provider BRL already runs for GoComet). Requires the Maytapi credentials connected on the server; until then the badge reads **Setup pending** and alerts stay in the worklist only.
- **Dashboard worklist**: every alert appears in the console (the Price Requests worklist + History) and nowhere else. No setup, always on regardless of channel.

## The six alerts

| Alert | Fires when |
|-------|-----------|
| Price needed | a new in-scope load is discovered and needs a cost entered |
| Bid live | the bot places its first real bid on a load |
| Outbid | the bot drops out of rank 1 on a load |
| Won | a load closes with the bot at rank 1 |
| Lost | a load closes and the bot is not rank 1 |
| Error | the bot hits a problem that needs a human (auth failure, repeated read failures, a blocked bid) |

## Recipients — who gets what

Recipients are no longer edited on the Notifications tab itself. They derive from two pages:

- **Team**: add a person with their name + phone (with country code, e.g. `+91...`) and tick which
  of the six alerts they should receive. A person with no customer assignments and "alerts for
  every load" switched on is a central desk that gets everything; anyone else needs at least one
  assignment before they receive anything scoped to it.
- **Assignments**: the matrix pairing people to customers. A pairing scopes that person's alerts
  to that customer's loads, and can carry its own margin/alert overrides for that specific pairing.

The Notifications tab itself now only shows the WhatsApp channel toggle, a send-test tool, and the
recent-sends log - it's a read-only summary of what Team + Assignments already configured.

## Turning on WhatsApp

Maytapi needs no template approval - the bidder renders each alert and sends it as plain text.

1. **Credentials.** In the on-box `.env` (never in git), from BRL's Maytapi console:
   ```
   SP_WHATSAPP_ENABLED=1
   SP_MAYTAPI_TOKEN=<the account's API token>
   SP_MAYTAPI_PRODUCT_ID=<the account's product id>
   SP_MAYTAPI_PHONE_ID=<the linked sender's phone id>   # which number alerts go out from
   ```
   The phone id picks which linked WhatsApp number sends the alerts (list the account's numbers/phoneIds via Maytapi's listPhones). Restart the app after editing `.env`.
2. **Switch the channel.** On the Notifications tab, select **WhatsApp**. When connected, the badge reads **Connected**; until then it reads **Setup pending** and alerts stay in the worklist only.
3. **Add recipients** on the **Team** page (name, phone, alert types) and assign them to customers on **Assignments**.
4. **Verify.** Use **Send test** on the Notifications tab to send a test WhatsApp message to any number. A success confirms the token, product id, phone id, and number are correct.

## Delivery visibility

The Notifications tab shows **Recent alerts sent** (last few days) with success/failure per send, so a silent failure is visible. Sends never block or delay a bid.

## When the sender logs out - re-linking it

The linked WhatsApp number occasionally drops its session. Maytapi keeps answering `success: true`
on every send and delivers nothing, so the failure is silent; the health monitor
(`scripts/monitor-wa-sender.js`, cron) is what turns it into an alert within minutes.

Recovery is a physical act - a phone has to scan a pairing QR. There are three ways to get one, in
order of preference.

**The alert itself is deliberately short** - what is broken, that bidding is unaffected, how long it
has been down, and the link. It is read on a phone mid-outage, so everything below is here rather
than in the message. If the link does not work for you, options 2 and 3 are what to do next.

1. **The on-demand page** - `/api/wa/relink-qr` on the bidder itself, behind the normal operator
   login. The down-alert links straight to it. It shows a live QR and pulls a fresh one every 10
   seconds (for up to 15 minutes, then it stops and says so), which matters because the code
   rotates roughly every 20 seconds. A line under the code says which of the four states you are
   looking at: live, re-linked, session expired, or Maytapi not answering.

   **You will be asked for credentials twice, and both prompts are expected.** In production the
   app binds loopback and nginx is the only front door, with HTTP Basic auth on everything except
   `/price/` (`deploy/nginx/bidder.conf`; see "Two auth layers, by design" in `DEPLOY.md`). So the
   sequence on a phone is: the browser's own popup asking for the **shared console username and
   password**, then the bidder's **operator login**. The first one is unstyled and unbranded and
   looks like nothing else in the product - mid-outage it reads as a broken link, and the natural
   next move is to give up and go to option 3, which is the fallback this page exists to replace.

   An alert read on a personal phone usually has no session, so after the Basic-auth prompt you are
   bounced to the console sign-in and then returned to the QR page. **Everyone on the
   `MONITOR_ALERT_TO` list needs BOTH credentials** for this path to work at all - the shared nginx
   one and their own operator login. If they have neither, they are on option 3. Confirm this at
   deploy time rather than during an outage (`DEPLOY.md` §6).
2. **The image in the alert** - opt-in, and **currently OFF** (`SP_WA_QR_IN_ALERT`; see the
   pre-enable step below). When on, the down-alert also DMs the QR to the alert numbers as a
   picture, and re-sends a freshly fetched one on a short bounded burst for the first ~20 minutes,
   because any single image has usually expired by the time someone reads it. Its caption says so
   and points back at the page.
3. **The Maytapi console** - `console.maytapi.com`, open the slot, scan the QR there. Use this when
   the bidder itself is unreachable at the same time.

### Before turning the image push on (`SP_WA_QR_IN_ALERT`)

The push leg has never delivered a real QR. The wire shape is live-verified, but that was done with
a tiny synthetic PNG, and it proves nothing about the only question that matters: whether a real
pairing QR is still **scannable** after WhatsApp re-encodes the image. An unscannable one is worse
than no image, because it wastes the operator's time during an outage.

So the flag stays off until someone runs, once, against a spare or already-logged-out slot:

```
node scripts/probe-sender-qr.js --slot <idle-phoneId> --to <admin-msisdn> --yes
```

It refuses an active slot and refuses a group recipient. Then check on a phone that the image
rendered **and that another phone actually scans it off the screen**, and record the result in
`sendQrImage()`'s header in `scripts/lib/sender-qr.js`. Only then set `SP_WA_QR_IN_ALERT=1`.
Layer 1 and layer 3 are unaffected by the flag and work today.

**Scan only from the handset that owns the sender number.** The page names it, above the QR, at the
moment you are about to scan. The alert points you there rather than repeating it - except on a box
with no in-app page configured, where there is no page to point at and the alert says it in full.
This is the one mistake that is expensive: the scanning phone becomes the linked account, so
scanning from any other handset re-points BRL's outbound WhatsApp at that person's account -
customer messages start going out from it and their private traffic starts arriving in BRL systems.

**A number change and a takeover are different events, and they get different messages.** The
monitor compares the number the slot comes back on against the last one it saw, and then asks
whether the new number is one of BRL's - reading the other slots on BRL's own Maytapi product plus
the staff allowlist at `data/staffRoster.json`, the same file the daily group tripwire maintains.

- **One of BRL's** - a handset swap. One short email, once: *"The bidder's WhatsApp moved to X. It
  was on Y. Both phones are BRL's, so nothing is wrong."* No Telegram, no WhatsApp copy. The new
  number is adopted, which is what keeps it to one message rather than one every thirty minutes.
- **Not one of BRL's** - the full alarm, on every tier, at the urgent cadence, and the re-link page
  refuses to hand out a pairing code while it stands. The number is never adopted, so the alarm
  cannot silence itself. The fix is to unlink the bidder from that handset (WhatsApp > Linked
  Devices) and re-link from the right one - **unless** it is a new BRL phone nobody has added to the
  staff allowlist, which reads identically from here. The alert says so and offers that first.

This replaced a pinned `SP_MAYTAPI_SENDER_NUMBER`, which declared one owning number and alarmed on
everything else. Because BRL moves the sender between its own handsets, that alarmed on every
legitimate swap and its only remedy was to re-type the pin. On 2026-09-22 a correct re-link back to
BRL's original handset produced 35 hours of urgent alarms naming that handset as the intruder. If a
BRL handset is missing from the staff allowlist you get the same shape of false alarm, which is why
keeping that list current is the one upkeep this check needs.

**The comparison still has a precondition: the monitor must know a previous number.** It learns one
on a run where the slot is *healthy*, so on a box that has never seen the sender up there is nothing
to compare against. The monitor does not go quiet about that, and says it on two surfaces because
two different people have to act:

- **Whoever is about to scan** sees `NO NUMBER ON RECORD for this slot, so the wrong-phone check is
  OFF` on the re-link page, above the QR, and on the caption of a pushed QR image. On a box with no
  in-app page there is no page and no caption, so the alert itself carries the line.
- **Whoever can fix it** sees it off-box: the healthcheck ping and run log carry `baseline=none`
  when there is nothing on record and `baseline=ok` once there is. This is why `HEALTHCHECK_URL` is
  a required deploy step and not an optional nicety.

A recovery onto a number with nothing on record is announced as *"back, on a number we cannot
check"*, naming it, never as a plain recovery. A later recovery onto a number that is not on BRL's
list reads as an ordinary restore **plus** one line saying so - because at that point the slot is
comparing against itself, and a green tick that did not say so would claim more than the check
supports. A recovery onto a number that *is* on BRL's list carries no hedge at all.

**Alerts are only ever sent from the bidder's own slots**, `128023` and `136151`
(`MONITOR_ALERT_FROM_PHONES`). BRL's Maytapi product holds seven slots and most are the sales desk's
working numbers; the picker used to take the first active one in board order, which is a sales
number. If both bidder slots are down the WhatsApp tier goes quiet and email carries the alert.

If you receive a QR image on WhatsApp from the alert sender, it is expected (once the flag above is
on) - it only ever goes to the individual admin numbers in `MONITOR_ALERT_TO`, never to a group.

## Notes

- Config changes (recipients, channel, targets, margins) are recorded in **Settings -> Recent changes** with who changed what and when.
- Entering the cost by replying on WhatsApp (two-way capture) is not part of this build.
- `.env` variables and defaults are documented in `.env.example`; deploy steps in `DEPLOY.md`.
