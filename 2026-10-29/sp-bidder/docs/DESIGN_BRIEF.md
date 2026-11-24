# DESIGN BRIEF — Freight Auto-Bidding Bot (one-screen demo)

**Audience:** non-technical Indian logistics business owner.
**Goal of the screen:** tell one story, calmly — *connect your account -> see your live freight auctions -> set your floor price -> watch the bot bid to win, never below your floor.*
**Feel:** credible, calm, premium. NOT a busy dashboard. NOT generic-AI-purple-gradient slop. Simple and confident.
**Handoff:** this brief is implemented with the `frontend-design` skill. Values below are exact and copy-pasteable. Prefer them over taste.

---

## 0. THE THREE DECISIONS (read first)

1. **Light mode**, near-white layered neutrals. (Rationale in §2.)
2. **ONE accent: deep pine-green `#0B7A5B`.** It carries brand + primary action + "winning/won." No second accent. Purple is banned.
3. **Single centered column, ~600px, hairline-bordered cards.** One screen, top-to-bottom story. (Layout in §6, Option A.)

Everything else serves those three.

---

## 1. REFERENCE AESTHETIC — what the best do, and what we borrow

The interfaces universally regarded as the cleanest share six moves: **restraint (one accent, rationed), generous whitespace, muted near-neutral grays, type hierarchy instead of decoration, hairline borders over heavy shadows, and tabular numerals for anything financial.** Six specific products and the one thing each does that we copy:

| Product | What it does right | What we borrow |
|---|---|---|
| **Linear** ([brand](https://linear.app/brand), [tokens](https://copycats.design/linear-app)) | One accent rationed to a single primary action per screen; everything else lives in a tight monochrome cool-gray scale. Inter at a 510/400 weight split is the whole "voice." | Ration the accent to exactly one job per card (the winning bid / the primary button). Two weights do the hierarchy: 600 for emphasis, 400 for body. |
| **Vercel / Geist** ([colors](https://vercel.com/geist/colors), [breakdown](https://www.shadcn.io/design/vercel)) | Near-white `#fafafa` body, ink `#171717` type, a deliberate gray scale where every border/divider sits on its own named step. Borders, not shadows, do the separation. | The layered-neutral discipline and hairline-border-first instinct. Each gray has a job. |
| **Stripe** ([style tokens](https://docs.stripe.com/stripe-apps/style), [system breakdown](https://www.designmd.co/blog/stripe-design-system-breakdown)) | Near-monochrome canvas, **one** accent, display headings in a light weight with negative tracking. Every currency/numeric cell uses **tabular figures** — the quiet "financial DNA" tell. | `tabular-nums` on every rupee figure and bid. Negative letter-spacing on big numbers. Authority through restraint, not volume. |
| **Mercury** ([screens](https://nicelydone.club/apps/mercury), [teardown](https://uxplanet.org/captivating-design-of-the-mercury-fintech-app-d472bc0288bb)) | Banking that feels calm and "in control" — visibility of state gives the user relief. Premium signalled by subtle motion, not chrome. | The calm-money tone. State visibility = the floor/bid/position are always legible at a glance, no hunting. |
| **Raycast** ([fresh look](https://www.raycast.com/blog/a-fresh-look-and-feel), [system](https://getdesign.md/raycast/design-md)) | Fast, simple, native; icons are a single outline set with consistent stroke width. Compact mode blends away everything non-essential. | One consistent line-icon set (Lucide), single stroke width. Cut every element that isn't load-bearing. |
| **Things 3** (Cultured Code) | The reference for restraint and whitespace: a single column, enormous breathing room, one tint of accent, no visual noise. Reads premium precisely because it's quiet. | The single-column calm and whitespace budget — let the screen breathe; resist filling it. |

**Synthesis (the shared formula):** muted neutral surfaces + exactly one accent + type-hierarchy-not-decoration + hairline borders + tabular financial numerals + sparing, purposeful motion. That is the entire recipe and we follow it literally.

---

## 2. COLOR — light mode, exact hex

**Why light, not dark:** the user is a traditional logistics owner who may view this on a bright-office laptop, a phone in a yard, or a projector in a demo. Light reads as trustworthy fintech/SaaS (Stripe, Mercury, Linear's light mode, Vercel) to a non-technical audience; dark skews "crypto/gamer" and is riskier on bad projectors. Light it is.

Neutrals are near-neutral with the faintest warm tint (avoids both the sterile-clinical and the dated-beige failure modes). The single green accent supplies all the life.

```css
:root {
  /* ---- Background layers (light) ---- */
  --bg-canvas:        #FBFBFA; /* page background, barely-warm near-white */
  --bg-surface:       #FFFFFF; /* cards, primary surfaces */
  --bg-subtle:        #F4F4F2; /* inset rows, muted fills, secondary surface */
  --bg-hover:         #F0F0EE; /* row/button hover wash */

  /* ---- Borders ---- */
  --border:           #E7E7E4; /* default 1px hairline (cards, dividers) */
  --border-strong:    #D6D6D2; /* inputs, emphasised separation */

  /* ---- Text ---- */
  --text-primary:     #1C1C1A; /* ink — headings, values (NOT pure black) */
  --text-secondary:   #5C5C57; /* body, labels */
  --text-muted:       #76756F; /* captions, meta, timestamps (AA-safe ~4.7:1) */
  --text-on-accent:   #FFFFFF;

  /* ---- THE accent: deep pine-green (brand + primary + winning) ---- */
  --accent:           #0B7A5B; /* default */
  --accent-hover:     #0A6B50;
  --accent-pressed:   #095C45;
  --accent-text:      #0A6B50; /* accent used AS text on light (AA-safe) */
  --accent-tint-bg:   #EEF8F3; /* very subtle fill behind a winning card/badge */
  --accent-tint-border:#C9E9DD;

  /* ---- Semantic (success REUSES the accent green — one color family) ---- */
  --warning:          #B45309; /* "held at your floor", outbid-risk */
  --warning-bg:       #FDF3E7;
  --warning-border:   #F2D9B0;
  --danger:           #B42318; /* "lost / outbid" — muted clay, never pure red */
  --danger-bg:        #FCEEED;
}
```

**Rules:**
- The accent green is the *only* hue. "Won" and "#1 winning" reuse it. There is no separate brand color, no second accent.
- Success is not a third color — it *is* the accent. Warning amber and danger clay are the only other hues, used rarely and small (a badge, a word), never as fills covering a card.
- The floor price is communicated in **ink** (`--text-primary`) with a small lock icon — deliberately *not* colored, so the accent stays reserved for the bid/winning. Floor = a fact; bid = the live action.
- Pure black `#000` and pure white harsh shadows are banned — they read cheap. Ink is `#1C1C1A`.
- Verify all pairings hit WCAG AA at implementation (muted text only on `#FFFFFF`/`#FBFBFA`, never on `--bg-subtle`).

**Alternative accent (only if they reject green):** deep slate-blue `#1F5F8B` / hover `#1A5277`. Recommend green decisively — the entire story is *win / money saved*, and green carries that without a word.

---

## 3. TYPOGRAPHY — system fonts, offline, no CDN

System stack delivers San Francisco on Apple, **Segoe UI on Windows** (the likely demo machine), Roboto on Android/Linux. All premium, all local, zero network.

```css
:root {
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
               "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "Segoe UI Mono", "Roboto Mono",
               Menlo, Consolas, monospace;
}
```

**The single most premium fintech detail (borrowed from Stripe):** every rupee figure and bid uses tabular numerals so digits don't jitter when bids tick up.

```css
.num { font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; }
```

Apply `.num` to: hero figure, every bid, every floor, positions, any count.

### Type scale (base 16px)

| Token | Size | Weight | Line-height | Letter-spacing | Use |
|---|---|---|---|---|---|
| `hero` | 40px / 2.5rem | 600 | 1.05 | -0.02em | The one big number (bot's current bid on the focused auction, or total saved). `tabular-nums`. |
| `title` | 24px / 1.5rem | 600 | 1.2 | -0.01em | Screen title (used once, if at all). |
| `card-title` | 17px / 1.0625rem | 600 | 1.3 | -0.005em | Lane name ("Mumbai -> Delhi"). |
| `body` | 15px / 0.9375rem | 400 | 1.5 | 0 | Default text, value statement. |
| `label` | 14px / 0.875rem | 500 | 1.4 | 0 | Field labels ("Your floor", "Bot's bid"). |
| `caption` | 13px / 0.8125rem | 400-500 | 1.4 | +0.01em | Truck type, load, timestamps, meta (muted). |
| `overline` | 12px / 0.75rem | 600 | 1.0 | +0.06em, UPPERCASE | Status micro-label ("WATCHING", "BIDDING", "WON"). |

**Letter-spacing rule of thumb:** tighten large type (negative tracking, >=24px), neutral for body (0), loosen tiny/uppercase labels (+0.04 to +0.08em). Only two weights carry hierarchy: **600** for emphasis, **400** for body (use **500** only for small labels). Resist a third heading weight.

---

## 4. SPACING, LAYOUT & RADIUS

```css
:root {
  /* 4px base, 8px rhythm */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px;
  --space-12: 48px; --space-16: 64px;

  --radius-sm: 6px;   /* chips, badges, inputs */
  --radius-md: 10px;  /* buttons */
  --radius-lg: 14px;  /* cards */
  --radius-pill: 999px; /* status dots, pills, avatars */

  --content-max: 600px;
}
```

- **Base unit 4px; primary rhythm 8px.** Every margin/padding/gap is a scale value — never an arbitrary `13px`.
- **Max content width 600px**, centered. Page padding: `24px` mobile, `32-48px` desktop. One column. This is the calm-premium move (Things/Mercury), and it suits 1-3 cards perfectly.
- **Card padding:** `20px` mobile, `24px` (>=640px).
- **Gap rhythm:** `8px` between a label and its value; `12-16px` between field rows inside a card; `16px` between cards; `24-32px` between major sections (top bar -> value line -> card list).
- **Radius:** cards `14px`, buttons `10px`, badges/pills `999px`. Do NOT go above 16px on big surfaces — over-rounding reads toy-like.

### Border vs shadow — the rule
**Flat surfaces get a 1px hairline border. Floating surfaces get a soft shadow. Never both heavy.** Cards sit on the canvas with `1px solid var(--border)` (+ optional `--shadow-xs` for a hair of lift). Shadow is reserved for things that genuinely float: the "Connected" account dropdown, a toast, a modal. A strong colored border is banned.

---

## 5. DEPTH & MOTION

```css
:root {
  --shadow-xs: 0 1px 2px rgba(20,20,18,0.04);
  --shadow-sm: 0 1px 3px rgba(20,20,18,0.06), 0 1px 2px rgba(20,20,18,0.04);
  --shadow-md: 0 4px 12px rgba(20,20,18,0.08), 0 2px 4px rgba(20,20,18,0.04); /* popover */
  --shadow-lg: 0 12px 32px rgba(20,20,18,0.12); /* modal only */
}
```
Shadows are tinted with ink (`rgba(20,20,18,...)`), not pure black, and kept low-spread. Use sparingly.

**Motion durations / easing:**
- Micro (hover, color, border): **120-150ms**, `cubic-bezier(0.4, 0, 0.2, 1)`.
- State change (status badge, position flip, value tick): **200-240ms**, `cubic-bezier(0.2, 0, 0, 1)` (decelerate).
- Entrance (card mount, toast): **280-320ms**, same decelerate easing, with a 40-60ms stagger across cards (fade + translateY 8px).

**Animate:**
- The bid number **counting up** as the bot bids, with a brief flash to `--accent` on increase, settling back to ink. (Reserve digit width via `tabular-nums` so nothing reflows.)
- Status transitions: `WATCHING -> BIDDING -> WON` as a crossfade on the overline badge.
- Position change `#2 -> #1`: a brief accent highlight on the badge.
- The **"Connected" live dot**: a gentle 2s opacity/ring pulse — the one tasteful "this is live" affordance.
- Button hover: bg/border only, 120ms.
- **WON moment:** at most one restrained, one-shot acknowledgement (badge fills accent + a single soft scale-settle). No confetti storm.

**Do NOT animate:** layout-shifting reflow on every tick (fix widths), parallax, animated/mesh gradients, skeleton shimmer everywhere, spinners for fast actions, bouncy spring overshoot (this is a money tool — calm, not playful). Honor `prefers-reduced-motion`: drop the count-up and pulse, switch to instant state changes.

---

## 6. INDIAN RUPEE FORMATTING

```js
// Whole rupees in the UI (no paise) + Indian lakh/crore grouping.
const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 0,
});
inr.format(124500);   // "₹1,24,500"
inr.format(1850000);  // "₹18,50,000"
```

**Rules:**
- Use `en-IN` so grouping is lakh/crore (`12,34,567`), never international (`1,234,567`).
- **Omit paise in the UI** (whole rupees) — less clutter. Keep paise only if a legal/accounting surface ever needs it.
- Use the ₹ glyph (U+20B9). Apply `.num` (`tabular-nums`) to every figure so live ticks don't shift width.
- **Live bids and floors show full digits** (`₹1,24,500`) — they must read as real money.
- **Only summary/value-statement figures** may compact to words (`₹2.4L saved`, `₹18.5L`). Never compact a live bid.
- Per-unit context goes in a muted caption (e.g. `₹/trip`, `₹/tonne`), never inline-shouting next to the number.

---

## 7. ANTI-PATTERNS — the AI-slop tells to avoid

1. **Purple/indigo -> blue gradients** on buttons, hero, or background. The #1 tell. One flat accent, no gradients.
2. **Glassmorphism overload** — stacked frosted translucent panels, `backdrop-filter` everywhere.
3. **Emoji as icons** (truck/money/check/fire). Use one Lucide line-icon set, single stroke width, or no icon.
4. **Three+ competing accents** / rainbow tags / every card a different color.
5. **Neon saturated gradients, animated mesh/"aurora" blobs** as backgrounds.
6. **Drop shadows on everything** — every card floating with a big blurry shadow. Flat + hairline instead.
7. **Centering everything** — centered body text and centered multi-field cards. Left-align content; right-align numbers.
8. **Over-rounded everything** (>=20px radius on big cards) — reads toy-like.
9. **Saturated colored card outlines / heavy colored 1px borders.**
10. **Too many font weights/sizes**, decorative font pairings, long ALL-CAPS strings.
11. **"AI-powered" badge, ✨ sparkle icon, gradient-text headline.** None of it.
12. **Skeleton shimmer + spinners + progress bars all at once**; fake "AI thinking" animations.
13. **Dashboard chrome** — sidebars, KPI tile grids, charts, breadcrumbs. We want ONE calm screen.
14. **Low-contrast gray-on-gray** (`#aaa` on `#f5f5f5`) that looks "designed" but fails legibility.
15. **Inconsistent spacing / mixed radii / mixed icon stroke widths.**
16. **Bold everything** — when all is bold, nothing is emphasized.
17. **Pure-black text + pure-white + heavy shadow** harshness.

---

## 8. LAYOUT — our one screen

Single centered column, ~600px, light. The screen reads top-to-bottom as the story: connected (top) -> what's happening in one line -> the live auctions.

### OPTION A — Stacked auction cards (RECOMMENDED)

```
+--------------------------------------------------------------+
|                                                              |   <- page canvas #FBFBFA
|   FreightBot                          (*) Connected  v       |   <- top bar: wordmark left;
|                                       Best Roadways           |      green pulse dot + "Connected"
|                                                              |      + account name, right
|--------------------------------------------------------------|   <- 1px hairline under top bar
|                                                              |
|   Your bot is bidding on 3 live auctions - winning 2,        |   <- value statement, body 15px,
|   never below your floor.                                    |      one line, left-aligned
|                                                              |
|   +------------------------------------------------------+   |
|   |  Mumbai -> Delhi                       #1  WINNING   |   |   <- card-title 17px;  position
|   |  32ft Multi-Axle . 18 T                              |   |      badge accent-tint, right
|   |                                                      |   |
|   |  YOUR FLOOR            BOT'S CURRENT BID             |   |   <- two labels (overline, muted)
|   |  [lock] 1,18,000      Rs 1,24,500                    |   |      floor in ink, bid in ACCENT
|   |                                                      |   |      both .num tabular
|   |  ----------------------------------------------      |   |   <- hairline divider
|   |  Watching  >  BIDDING  >  Won           live (*)     |   |   <- status track; current step
|   +------------------------------------------------------+   |      bold/accent; live dot
|                                                              |
|   +------------------------------------------------------+   |
|   |  Pune -> Bangalore                     #1  WINNING  |   |
|   |  20ft Container . 9 T                                |   |
|   |  YOUR FLOOR            BOT'S CURRENT BID             |   |
|   |  [lock] 64,000        Rs 71,200                      |   |
|   |  ----------------------------------------------      |   |
|   |  Watching  >  BIDDING  >  Won           live (*)     |   |
|   +------------------------------------------------------+   |
|                                                              |
|   +------------------------------------------------------+   |
|   |  Surat -> Jaipur                       #2  HOLDING  |   |   <- #2 -> position badge in
|   |  32ft Multi-Axle . 21 T                             |   |      WARNING amber, not accent
|   |  YOUR FLOOR            BOT'S CURRENT BID             |   |
|   |  [lock] 92,000        Rs 92,000  (at floor)         |   |   <- bid == floor: "at floor" in
|   |  ----------------------------------------------      |   |      muted; bot will not go lower
|   |  Watching  >  BIDDING  >  Held          live (*)     |   |
|   +------------------------------------------------------+   |
|                                                              |
+--------------------------------------------------------------+
```

**Why A wins:** scannable, calm, repeats one clean card pattern, scales to 1 or 3 auctions without redesign, and every card answers the four owner questions at a glance — *which lane, what's my floor, what's the bot bidding, am I winning.* It mirrors Things/Mercury single-column restraint.

**Per-card content (plain language, fixed order):**
- **Lane** — `Origin -> Destination` (card-title). The arrow `->` rendered as a real arrow glyph or inline SVG, not a hyphen.
- **Truck + load** — caption, muted (`32ft Multi-Axle . 18 T`).
- **Your floor** — overline label + ink value with a small lock icon. Never colored.
- **Bot's current bid** — overline label + value in **accent** when winning; in **ink/muted** when at floor or losing.
- **Position badge** (top-right): `#1 WINNING` in accent-tint; `#2 HOLDING / OUTBID` in warning amber. One badge only.
- **Status track**: `Watching -> Bidding -> Won` (or `Held` / `Lost`), current step emphasized (accent, 600), past steps muted, future steps faint. A small live pulse dot on the right while active.
- **"At floor" affordance**: when bid == floor, show a quiet muted `(at floor)` next to the bid — this is the proof of the promise *"never below your floor."* Do not make it loud; its calm is the point.

**Floor editing (set-your-floor beat):** the floor value is an inline control — hover reveals a small pencil/`Edit` affordance; click turns it into an input with the same `.num`/`en-IN` formatting. For the static demo, one card may show the floor in an active "set" state to tell the *set your floor* beat.

**Top bar:** wordmark left (e.g. `FreightBot`); right side = green pulse dot + `Connected` + account name (`Best Roadways`) with a caret to a dropdown (`shadow-md`). The pulse dot is the live affordance — it sells *connect your account* without a wizard.

### OPTION B — Single hero auction (use only if there is exactly one auction to show)

```
+--------------------------------------------------------------+
|   FreightBot                          (*) Connected  v       |
|--------------------------------------------------------------|
|                                                              |
|   Mumbai -> Delhi   .   32ft Multi-Axle . 18 T               |   <- lane as the headline
|                                                              |
|   Rs 1,24,500                              #1  WINNING       |   <- HERO number, 40px/600,
|   Bot's current bid                                          |      accent; position badge right
|                                                              |
|   Your floor  [lock] Rs 1,18,000   .   never bids below      |   <- the promise, in muted ink
|                                                              |
|   Watching  ------>  BIDDING  ------>  Won        live (*)   |   <- wide status track
|                                                              |
+--------------------------------------------------------------+
```

**Verdict:** ship **Option A.** It tells the full *connect -> see auctions -> floor -> win* story, handles 1-3 auctions, and stays calm. Reserve B as the empty-ish / single-lane variant only.

---

## 9. IMPLEMENTATION NOTES FOR THE ENGINEER

- Icons: **Lucide** line set only (`lock`, `arrow-right`, `chevron-down`, `circle` for the live dot, `pencil`/`edit-3`). One stroke width (1.5px). No emoji, ever.
- Numbers: wire `Intl.NumberFormat('en-IN', ...)` once as a helper; apply `.num` class everywhere it renders.
- The "live" tick: simulate the bot raising its bid every few seconds with the count-up + accent-flash; keep digit width fixed.
- Respect `prefers-reduced-motion` (drop count-up + pulse).
- Everything is one of the scale values in §4 — no arbitrary spacing or radii.
- Ship light mode only for the demo; the token structure already supports a later dark theme if needed.

---

## Sources

- [Vercel Geist — Colors](https://vercel.com/geist/colors) and [Geist breakdown](https://www.shadcn.io/design/vercel)
- [Linear — Brand](https://linear.app/brand) and [Linear design tokens](https://copycats.design/linear-app)
- [Stripe Apps — Style tokens](https://docs.stripe.com/stripe-apps/style) and [Stripe design system breakdown](https://www.designmd.co/blog/stripe-design-system-breakdown)
- [Mercury — UI screens](https://nicelydone.club/apps/mercury) and [Mercury design teardown](https://uxplanet.org/captivating-design-of-the-mercury-fintech-app-d472bc0288bb)
- [Raycast — A fresh look and feel](https://www.raycast.com/blog/a-fresh-look-and-feel) and [Raycast design system](https://getdesign.md/raycast/design-md)
- Things 3 (Cultured Code) — referenced for single-column restraint and whitespace discipline.
- INR formatting: [Indian numbering system](https://en.wikipedia.org/wiki/Indian_numbering_system) + `Intl.NumberFormat('en-IN')` best practice.
