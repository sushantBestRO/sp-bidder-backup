# Price-capture page — live-state behaviour scope

Design scope for the tokenized cost-entry page (`GET/POST /price/:token`). Written after a
client-visible dry-run where a second person opened the link after the load was already priced
and saw a raw error. The error-message half is fixed; this documents how the page should behave
when the request state changes *while the form is open*.

## The scenario

The price link is shared to the pricing team (WhatsApp). More than one person can hold the same
link, or the same person can have it open on two devices. The request has a single owner state:

```
awaiting_price -> armed            (someone captured the cost)
               -> skipped_no_price (deadline passed, no cost)
               -> dismissed        (operator declined)
               -> closed           (auction ended)
```

Only `awaiting_price` should show the form. Every other state is "already handled — nothing to do".

## What happens today

- `GET /price/:token` renders the form only when `awaiting_price`; any other state renders a
  friendly status page (`renderRequestStatus`). Correct.
- `POST /price/:token` re-checks state before capturing; a raced submit renders the same friendly
  status page instead of a raw 409. Correct.
- **Gap:** the form itself (`renderPriceForm`) is a static snapshot. Its only live element is the
  countdown timer. It does **not** poll request state. So if the load is priced (or closed, or
  dismissed) while someone has the form open, their page keeps showing an empty cost input. They
  find out only *after* typing a number and submitting — a wasted round-trip, and the moment that
  reads as "it's broken" to someone who doesn't know a teammate already handled it.

## Principles (established practice)

1. **The server is the single source of truth for who wins the race.** The status-guarded state
   transition in `capture()` (reject unless `awaiting_price`) is exactly optimistic concurrency
   control — assume no conflict, verify at write time, reject a stale write. Keep it. Client-side
   checks are advisory; they improve the *experience*, they are not the safety mechanism.
2. **Never surface a raw conflict.** Translate "not open (status=armed)" into a human outcome plus
   the next useful action. Done (`renderRequestStatus` + the "Track the live bid" link).
3. **Reflect the state change before the user acts, not after.** A shared, long-lived form should
   become aware that the underlying resource changed and update itself, so the user never spends
   effort on an action that can't succeed. This is the missing piece.
4. **Make the wasted action impossible, gracefully.** The instant state leaves `awaiting_price`,
   the form should stop being a form.
5. **Idempotent + safe under a late/double submit.** A second submit (teammate, or a double-tap)
   must never double-arm or overwrite the first cost. The status guard already guarantees this;
   the UI should also disable the button on tap so the common double-tap never even fires twice.

## Target behaviour — state by state

The page is a small state machine keyed on the live request status, polled from the server.

| Live state | What the open page should do |
|---|---|
| `awaiting_price` (fresh) | Show the form. Poll state every 3–5s. Keep the skew-corrected countdown. |
| `awaiting_price`, closing soon | At a lead threshold (e.g. deadline − 2 min) show a "closing soon — submit now" nudge. At the deadline, lock the input and swap to the expired view. |
| `armed` (a teammate priced it) | Auto-swap the card, without a submit, to "Cost already submitted — the bot is on it", with the submitted-at time and the "Track the live bid" link. Optionally a one-line heads-up the moment it flips ("This load was just priced by your team"). |
| `closed` | Auto-swap to "Auction ended" (+ win/loss + final rank when known). |
| `skipped_no_price` | Auto-swap to "Request expired — no cost was entered; the bot did not bid." |
| `dismissed` | Auto-swap to "An operator declined this load." |
| submit in flight | Disable the button, show "Saving…". On success -> "Cost saved". On a raced 409 -> the friendly status page (already wired). |

## Mechanism (reuse what `/track` already does)

`/track/:token` already has the whole pattern: a tiny inline poller, a `/track/:token/state`
JSON projection, a `serverTime`-based clock-skew offset, and a stop-on-terminal guard. Mirror it
on the form:

- Add a minimal `GET /price/:token/state` returning `{ status, capturedAt, closesAt, serverTime }`
  (or reuse `/track/:token/state`, which already carries `requestStatus`).
- The form polls it every 3–5s. **The simplest correct swap:** when the polled status is no longer
  `awaiting_price`, call `location.reload()`. The existing `GET` handler already renders the exact
  right status page for every non-open state — so a reload gets the correct page for free, no
  duplicated client-side rendering of each state. (A fancier version swaps the card in place; the
  reload is the low-risk first cut.)
- Countdown: reuse the `serverTime` offset so the phone's clock skew can't misfire the "closing
  soon" nudge or the deadline lock.
- Politeness: back the poll off when the tab is hidden (Page Visibility API) and stop it once a
  terminal state is reached. One load, mobile — cost is negligible either way.

## Edge cases to hold

- **Clock skew** — always drive "closing soon"/lock off `closesAt − (serverTime offset)`, never the
  device clock (this is the engine's core timing rule too).
- **Double-tap by the same person** — button disables on submit; the status guard is the backstop.
- **Forwarded link privacy** — the status page must keep not leaking the cost amount (only the
  original submit confirms it) and not naming who priced it until an operator identity exists.
- **Terminal is terminal** — once armed/closed/expired/dismissed, stop polling; nothing re-opens.

## Out of scope for the first cut (future)

- **Presence** ("someone on your team is viewing / typing a cost on this load now") — needs a
  server-tracked viewer set; genuinely useful for a shared link but a bigger surface.
- **Per-operator identity** — capturing who priced it (WhatsApp sender, or a name field) so the
  status page can say "priced by X at HH:MM" and show the cost back to the original submitter.
- **Push instead of poll** (SSE/WebSocket) — the poll is fine at this scale; revisit only if the
  page count grows a lot.

## First-cut summary

Poll request state on the form; the moment it leaves `awaiting_price`, reload so the correct
already-handled page shows itself — no submit required. Add a closing-soon nudge and a deadline
lock off the skew-corrected countdown, and disable the submit button on tap. All of it reuses the
`/track` poller and the status pages that already exist.
