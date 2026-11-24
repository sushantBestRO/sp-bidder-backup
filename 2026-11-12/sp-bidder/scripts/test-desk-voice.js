'use strict';
/**
 * The voice gate: nothing a human can read may call this system a bot.
 *
 * This is a business-confidentiality requirement from the Director, not a style preference.
 * The system must read as a central bidding desk operating on BRL's behalf. Screenshots get
 * forwarded, staff talk, and the counterparty platform must never be handed evidence of
 * automation. Every user-readable string is potentially seen by an outsider.
 *
 * It has now been asked for THREE times, because each pass fixed the copy that existed that
 * day and nothing stopped the next feature from writing the word again:
 *   - PR #3  (2026-07-09, 362b8a9) scrubbed the portal UI.
 *   - PR #75 (2026-07-24) scrubbed the WhatsApp ask lifecycle and settled the vocabulary.
 *   - PR #88 (2026-07-25) then shipped a NEW /price message saying "the bot will not bid it",
 *     sixteen days after the portal was declared clean.
 * A copy fix is a point-in-time event; only a gate is durable. That is what this file is.
 *
 * The settled vocabulary (from #75, kept here so the next author does not have to guess):
 *   - the product name is "Bid Command" (see directorEod.js, and the membership tripwire label)
 *   - "On this load - bidding when it counts."   NOT  "Bot is on this load"
 *   - "Revising our bid."                        NOT  "The bot is responding automatically."
 *   - first person plural ("we will not bid it") for desk-facing copy
 *   - no robot emoji anywhere
 *
 * Three parts, deliberately overlapping - each catches what the others structurally cannot:
 *   PART 1 renders every WhatsApp template (behaviour: what a customer group actually receives).
 *   PART 2 fetches the shipped bytes of every public page over real HTTP, inline <script>
 *          included - which is where #88's regression lived, invisible to a source read of the
 *          rendered text alone.
 *   PART 3 statically scans the copy surfaces, so a branch no test happens to exercise is still
 *          covered. Parts 1-2 prove the paths they walk; only PART 3 covers the ones they miss.
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

/**
 * The banned word, as a whole word only. Word-bounded on purpose: "bottom", "bottleneck",
 * "both" and the font name "Roboto" are all legitimate and must not trip the gate. The plural
 * is included because "the bots" reads exactly as badly as "the bot".
 */
const BANNED = /\bbots?\b/i;
const ROBOT_EMOJI = /🤖/;   // U+1F916, the robot-face emoji #75 removed

/** Report a hit with enough context that the fix is obvious from the failure line alone. */
const hit = (where, text) => {
  const m = text.match(BANNED);
  const i = m ? m.index : 0;
  return `${where}: banned word "${m ? m[0] : '?'}" in -> ...${text.slice(Math.max(0, i - 60), i + 60).replace(/\s+/g, ' ')}...`;
};

// =========================================================================================
// PART 3 fixtures: the copy surfaces, and the ONLY permitted internal identifiers.
// =========================================================================================

/**
 * Files whose strings can reach a human: WhatsApp templates + notification copy, the
 * server-rendered public pages, the operator console, and the legacy public/ fallback UI.
 * The engine is not scanned - its user-visible text reaches people only by flowing through
 * src/notify, which IS scanned, and scanning it directly would trip on log lines.
 */
function copySurfaces() {
  const root = path.join(__dirname, '..');
  const out = [];
  const add = (dir, re) => {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p); }
        else if (re.test(e.name)) out.push(p);
      }
    };
    if (fs.existsSync(dir)) walk(dir);
  };
  add(path.join(root, 'src/notify'), /\.js$/);
  add(path.join(root, 'dashboard/src'), /\.(ts|tsx)$/);
  add(path.join(root, 'public'), /\.(js|html)$/);
  out.push(path.join(root, 'src/web/server.js'));
  return out;
}

/**
 * Internal identifiers that contain the word but are never rendered to anyone. Each is an
 * EXACT trimmed-line match, not a pattern, so the allowlist cannot silently widen: change the
 * line and the gate starts failing again, which is the intended behaviour.
 *
 * These are deliberately NOT renamed. `/api/bot/*` is called by the built dashboard bundle and
 * by the legacy public/ UI; the `bot:` key is consumed by public/app.js; both are load-bearing,
 * and a rename orphans callers (and, for persisted shapes, stored records) to fix copy that no
 * human ever sees. A route path and a JSON key are not "copy".
 */
const ALLOWED_INTERNAL = [
  { file: 'src/web/server.js', line: 'bot: m ? {', why: 'JSON key on the mock-mode demo payload, consumed by public/app.js; not rendered as a word' },
  { file: 'src/web/server.js', line: "app.post('/api/bot/arm', (req, res) => {", why: 'API route path called by the dashboard bundle; renaming orphans callers' },
  { file: 'src/web/server.js', line: "app.post('/api/bot/stop', (req, res) => {", why: 'API route path called by the dashboard bundle; renaming orphans callers' },
  { file: 'src/notify/heartbeat.js', line: "log.error('membership audit: group list or the bot own number was unreadable - reporting audit unavailable');", why: 'server log line, operator-only, never sent or displayed' },
];

/**
 * Blank out comments while preserving line count, so a hit still reports its real line number.
 *
 * Comments are where the word legitimately lives - the codebase explains itself at length near
 * safety-critical code, and "the bot" is the honest word for a maintainer. Only shipped strings
 * are in scope here, so the scan must see the code with its commentary removed.
 *
 * LINE comments are cut FIRST, then block comments - and that order is load-bearing, not
 * incidental. server.js documents its Accept-header handling in a line comment that contains
 * the MIME wildcard `*​/​*`; blanking block comments first sees the `/*` inside that wildcard,
 * opens a comment that was never opened, and swallows the next ~300 lines of real code. Cutting
 * line comments first removes the wildcard before it can be misread.
 *
 * A line comment is cut at `//` unless a colon precedes it, which keeps a URL in a string
 * literal ("https://...") from being mistaken for a comment. Verified against the current tree:
 * no copy surface has a bare `//` inside a string literal.
 *
 * The allowlist round-trip assertion at the end of PART 3 is the check on this function - if it
 * ever over-eats again, a documented identifier stops being found and the suite fails loudly
 * rather than going quietly green over a blanked-out file.
 */
function stripComments(src) {
  const noLine = src
    .split('\n')
    .map((line) => {
      const i = line.search(/(^|[^:])\/\//);
      if (i < 0) return line;
      return line.slice(0, line.indexOf('//', i));
    })
    .join('\n');
  return noLine.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

// =========================================================================================

(async () => {
  const { app, store } = require('../src/web/server');
  const { PriceRequestStore, publicSeg } = require('../src/pricing/priceRequests');
  const templates = require('../src/notify/waTemplates');

  // ---------------------------------------------------------------------------------------
  // PART 1 - every WhatsApp template, rendered. This is what a customer group actually gets.
  // ---------------------------------------------------------------------------------------
  console.log('\n1. every rendered WhatsApp template is clean');

  ok(templates.MESSAGES.length >= 15, `all templates present to check (${templates.MESSAGES.length})`);
  for (const m of templates.MESSAGES) {
    const body = templates.renderMessage(m.kind, {});
    ok(body != null, `${m.kind}: renders`);
    ok(!BANNED.test(body), hit(`template "${m.kind}"`, String(body)));
    ok(!ROBOT_EMOJI.test(String(body)), `template "${m.kind}": no robot emoji`);
  }

  // The vocabulary #75 settled, pinned by value so a future edit cannot quietly walk it back
  // to the wording the Director rejected.
  const live = templates.renderMessage('bidding_live', {});
  ok(/bidding when it counts/i.test(live) && !/\bbot\b/i.test(live),
    'bidding_live keeps the settled phrasing ("bidding when it counts"), not "Bot is on this load"');

  // ---------------------------------------------------------------------------------------
  // PART 2 - the SHIPPED BYTES of every public page, inline <script> included.
  //
  // Reads what the server actually emits rather than the source that produced it, because the
  // #88 regression lived inside a JS string inside a template literal inside an inline script -
  // a place a source read of the page's visible text does not look.
  // ---------------------------------------------------------------------------------------
  console.log('\n2. every shipped public page is clean (inline scripts included)');

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const get = (p) => new Promise((resolve, reject) => {
    const u = new URL(base + p);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });

  const requests = new PriceRequestStore({ store, marginsPct: [12, 8, 6], minMarginPct: 6, platformKey: 'sp' });
  const load = (over = {}) => ({
    id: 'V-1', lane: { origin: 'Pune', destination: 'Alwar' },
    companyName: 'Havells India Limited', equipment: '32 Feet', units: 1,
    weight: 16, weightUnit: 'MT', closesAt: Date.now() + 20 * 60_000,
    softClose: false, closeModelKnown: true, ...over,
  });

  const openReq = await requests.createForLoad(load(), { deadlineAt: Date.now() + 18 * 60_000 });
  const armedReq = await requests.createForLoad(load({ id: 'V-2' }), { deadlineAt: Date.now() + 18 * 60_000 });
  await requests.capture(armedReq.id, { cost: 50_000 });
  const expiredReq = await requests.createForLoad(load({ id: 'V-3' }), { deadlineAt: Date.now() - 60_000 });
  await requests.expireOverdue(Date.now());
  const mvReq = await requests.createForLoad(load({ id: 'V-4', units: 2, quoteType: 'FTL' }), { deadlineAt: Date.now() + 18 * 60_000 });
  // The PMT + ceiling load: the shape whose preview branch carried the #88 regression.
  const pmtReq = await requests.createForLoad(load({ id: 'V-5', units: 22, quoteType: 'PMT', ceiling: 40_000 }), { deadlineAt: Date.now() + 18 * 60_000 });

  const pages = [
    ['/price (awaiting a cost)', `/price/${publicSeg(openReq)}`],
    ['/price (armed -> re-price)', `/price/${publicSeg(armedReq)}`],
    ['/price (expired)', `/price/${publicSeg(expiredReq)}`],
    ['/price (truck multi-vehicle)', `/price/${publicSeg(mvReq)}`],
    ['/price (PMT + ceiling)', `/price/${publicSeg(pmtReq)}`],
    ['/track (read-only)', `/track/${publicSeg(armedReq)}`],
  ];

  for (const [label, p] of pages) {
    const res = await get(p);
    ok(res.status === 200 || res.status === 410, `${label}: served (${res.status})`);
    ok(!BANNED.test(res.body), hit(label, res.body));
    ok(!ROBOT_EMOJI.test(res.body), `${label}: no robot emoji`);
  }

  // The exact string #88 shipped. Pinned by value: the preview branch that renders it only
  // fires for a PMT load carrying a ceiling, so a page-level scan alone could go green if that
  // fixture ever stops producing the branch.
  const SERVER_SRC = fs.readFileSync(path.join(__dirname, '../src/web/server.js'), 'utf8');
  ok(!/the bot will not bid it/i.test(SERVER_SRC),
    'the per-tonne-ceiling preview no longer says "the bot will not bid it" (PR #88 regression)');
  ok(/we will not bid it/.test(SERVER_SRC),
    'the per-tonne-ceiling preview speaks in the first person ("we will not bid it")');

  server.close();

  // ---------------------------------------------------------------------------------------
  // PART 3 - static gate over the copy surfaces, for the branches parts 1-2 never walk.
  // ---------------------------------------------------------------------------------------
  console.log('\n3. static gate: no banned word in any copy surface');

  const files = copySurfaces();
  ok(files.length >= 20, `copy surfaces discovered (${files.length} files)`);

  const root = path.join(__dirname, '..');
  const offenders = [];
  let allowedSeen = 0;
  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const raw = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const code = stripComments(fs.readFileSync(file, 'utf8')).split(/\r?\n/);
    code.forEach((line, i) => {
      if (!BANNED.test(line)) return;
      const allow = ALLOWED_INTERNAL.find((a) => a.file === rel && a.line === line.trim());
      if (allow) { allowedSeen++; return; }
      offenders.push(`${rel}:${i + 1} -> ${String(raw[i] || line).trim().slice(0, 150)}`);
    });
  }

  ok(offenders.length === 0,
    offenders.length ? `banned word on a copy surface:\n      ${offenders.join('\n      ')}` : 'no banned word on any copy surface');

  // The allowlist must stay honest in BOTH directions. If an entry stops matching, the line was
  // edited or removed and the entry is now dead cover for whatever replaces it.
  ok(allowedSeen === ALLOWED_INTERNAL.length,
    `every allowlisted internal identifier still exists exactly as documented (${allowedSeen}/${ALLOWED_INTERNAL.length})`);

  // The robot emoji, banned outright across the same surfaces - no allowlist, no exceptions.
  const emojiOffenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    if (ROBOT_EMOJI.test(src)) emojiOffenders.push(path.relative(root, file).replace(/\\/g, '/'));
  }
  ok(emojiOffenders.length === 0,
    emojiOffenders.length ? `robot emoji present in: ${emojiOffenders.join(', ')}` : 'no robot emoji on any copy surface');

  // ---------------------------------------------------------------------------------------
  // Completion sentinel. scripts/run-tests.js grades by EXIT STATUS only, so a file that ends
  // early - an unref'd timer, an early return, a swallowed rejection - is a silent green with
  // zero assertions. Printing the count and exiting explicitly is what makes this file's pass
  // mean something.
  // ---------------------------------------------------------------------------------------
  console.log(`\ndesk-voice: ${pass} passed, ${fail} failed`);
  assert.ok(pass > 0, 'the suite must assert something');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('desk-voice: FATAL', e);
  process.exit(1);
});
