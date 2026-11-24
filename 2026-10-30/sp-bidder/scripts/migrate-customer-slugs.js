'use strict';

/**
 * migrate-customer-slugs - rename a customerId slug across EVERY store that holds it, as one
 * planned, backed-up, all-or-nothing edit. First target: the live "borocil" key (label
 * "Borosil") -> "borosil", so capture links and the console stop showing a misspelled slug.
 * Generic on purpose: any future rename is `node scripts/migrate-customer-slugs.js old new`.
 *
 *   node scripts/migrate-customer-slugs.js <old-slug> <new-slug>            # DRY-RUN (default)
 *   node scripts/migrate-customer-slugs.js <old-slug> <new-slug> --apply    # write, with backups
 *   node scripts/migrate-customer-slugs.js borocil borosil --data-dir=./data
 *
 * ---------------------------------------------------------------------------------------------
 * THE customerId REFERENCE GRAPH (audited 2026-07-16; the reason each store below is or isn't
 * touched). customerId is the natural key slug(label) minted by src/model/customerStore.js.
 *
 * PERSISTED - REWRITTEN BY THIS SCRIPT (data/<collection>.json, FileStore keyed-doc shape
 * { [id]: doc }, see src/store/fileStore.js):
 *   1. customers.json      key = customerId; doc.customerId mirrors the key. The rename moves
 *                          the key, rewrites doc.customerId, and APPENDS the old slug to
 *                          doc.previousIds - the compat trail CustomerStore.getByAnyId() and the
 *                          console routes resolve stale ids through after a deploy.
 *   2. assignments.json    key = assignmentId = `${personId}::${customerId}` (composite FK,
 *                          src/model/assignmentStore.js); doc.assignmentId + doc.customerId.
 *                          Every `<personId>::<old>` key moves; both doc fields rewrite.
 *   3. priceRequests.json  key = capture token (NOT customer-derived; never moves). Two doc
 *                          fields reference the slug (src/pricing/priceRequests.js):
 *                            - marginSource: 'customer:<customerId>' or
 *                              'assignment:<personId>::<customerId>' (from model/resolve.js) -
 *                              shown on the /price page as the band's source pill;
 *                            - customer: {customerId, label} - the display/link-slug snapshot
 *                              taken at createForLoad; linkSlug() builds the pretty
 *                              /price/<slug>-<token> URL from it, so an in-flight request must
 *                              not keep linking under a retired slug.
 *   4. marginProfiles.json LEGACY (pre-model) store, kept on disk for rollback by
 *                          src/model/migrate.js; key = `${platformKey}:${customerKey}` where
 *                          customerKey is the same slug; doc.customerKey mirrors it
 *                          (doc.customerLabel is a display string - untouched). Renamed so a
 *                          model re-migration on an emptied box can never resurrect the old slug.
 *
 * PERSISTED - VERIFIED NO customerId, NOT TOUCHED:
 *   - people.json          keyed personId ('p'+digits / 'g'+group-jid); no customer refs.
 *   - config.json          allowlist.shippers + recipients[].scope.shippers are RAW free-text
 *                          alias strings matched against load.companyName (tokenMatch), never
 *                          slugs; renaming a slug does not change what matches.
 *   - notifSent.json       dedupe keys `${loadId}_${kind}` (src/notify/notifier.js).
 *   - closedBids.json      keyed loadId; rows carry the raw `shipper` string.
 *   - intents*.json        scheduler intents carry loadId + raw companyName only.
 *   - accountContacts      keyed accountId. users/session/secrets: no customer refs.
 *
 * RENDERED / RUNTIME (read the stores above; correct on the next read after --apply):
 *   - Outbound capture/track links /price|/track/<slug>-<token>: slug from linkSlug()
 *     (src/pricing/priceRequests.js) - prefers the request's customer snapshot (rewritten here);
 *     the trailing token is the only authoritative part, so OLD links keep resolving.
 *   - WhatsApp price_needed *Name* line: notifier.requestPrice's shipperName (display) - reads
 *     the same rewritten snapshot. Scope routing stays on the raw companyName.
 *   - Console worklist / live bids / history rows: customerTagFor() in src/web/server.js -
 *     live matchCustomer projection, no stored slug, follows the rename automatically.
 *   - Console + legacy API routes holding a slug in the PATH (/api/customers/:customerId/delete,
 *     /api/margin-profiles/:platform/:customerKey/...): resolve retired slugs via
 *     CustomerStore.getByAnyId() over the previousIds this script writes.
 *   - React console (dashboard/): customerId lives in fetched state + POST bodies only, never
 *     in the browser URL - nothing to migrate there.
 * ---------------------------------------------------------------------------------------------
 *
 * Safety model (live-money data files, so belt AND suspenders):
 *   - DRY-RUN by default: prints the full key-by-key change plan and writes NOTHING. --apply is
 *     the only way anything is written.
 *   - The whole plan is computed and VALIDATED first (old slug must exist on the customers
 *     store; no target key may already exist anywhere) - a collision refuses the entire run
 *     rather than half-renaming.
 *   - --apply first copies every file it will touch to <file>.bak.<timestamp>, then writes all
 *     files via the store's own writeJSONAtomic. If ANY write throws, every file already
 *     written is restored from this run's backups before exiting non-zero - no partial rename
 *     is ever left on disk.
 *   - The apply is recorded to the configChanges audit stream (same stream the console's
 *     margin/customer edits audit to), so the rename shows up in the operational record.
 *
 * Deploy ordering - the bid-command service MUST be stopped before --apply. Do NOT run a live
 * apply against a running box:
 *   1. Ship the code that reads previousIds (customerStore getByAnyId + console fallbacks) FIRST
 *      and `pm2 restart bid-command` so the new stale-slug resolution path is live.
 *   2. `pm2 stop bid-command` to take the bot out of service BEFORE applying. This is mandatory,
 *      not a nicety. Plain-English why: --apply reads all four collections into memory, then
 *      rewrites each WHOLE map back through the store, which has no cross-process lock. Any server
 *      write that lands between this script's read and its write is silently overwritten - a lost
 *      update, no error, no trace. priceRequests.json is the hot one (the bot writes a new request
 *      on every discovery tick, for every customer, not just the one being renamed), so a live
 *      apply WILL race it and can drop a just-armed request or erase a just-captured cost. A
 *      stopped service has no concurrent writer, so the clobber cannot happen.
 *   3. Run this script with --apply.
 *   4. `pm2 restart bid-command` to bring the bot back - boot re-arms every still-open intent and
 *      refreshes the model snapshot server.js caches at boot (touching any customer in the console
 *      also refreshes it).
 * Operate this app BY NAME only (`bid-command`); never `pm2 stop all` / `pm2 restart all` on the
 * shared box. Old WhatsApp links keep working throughout: the token, not the slug, resolves.
 */

const fs = require('fs'); // allowed: ops script (backups + fixture-safe IO), not app runtime state
const path = require('path');
const { readJSON, writeJSONAtomic, appendJSONL } = require('../src/store/atomicFile');

// Same shape rule the CustomerStore slug() mints: lowercase [a-z0-9-], <= 40 chars, no
// leading/trailing '-'. A new slug that the store itself could never mint is a typo.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const usage = () => {
  console.error('usage: node scripts/migrate-customer-slugs.js <old-slug> <new-slug> [--apply] [--data-dir=<dir>]');
  process.exit(2);
};

function parseArgs(argv) {
  const pos = [];
  let apply = false;
  let dataDir = null;
  for (const a of argv) {
    if (a === '--apply') apply = true;
    else if (a.startsWith('--data-dir=')) dataDir = a.slice('--data-dir='.length);
    else if (a === '--data-dir') dataDir = ''; // caught below as missing value
    else if (a.startsWith('--')) { console.error(`unknown flag: ${a}`); usage(); }
    else pos.push(a);
  }
  if (pos.length !== 2 || dataDir === '') usage();
  return { oldSlug: String(pos[0]), newSlug: String(pos[1]), apply, dataDir };
}

/**
 * Compute the full change plan over the four slug-bearing collections. Pure: reads the maps
 * handed in, returns { changes, errors } and mutates nothing - the same plan is what the
 * dry-run prints and what --apply executes, so what you saw is exactly what gets written.
 * Each change: { file, kind: 'key-rename'|'field-rewrite', from, to, detail }.
 */
function planRename({ customers, assignments, priceRequests, marginProfiles }, oldSlug, newSlug) {
  const changes = [];
  const errors = [];
  const has = (m, k) => Object.prototype.hasOwnProperty.call(m || {}, k);

  // -- customers.json: the anchor. No old key = nothing to migrate; a present new key = a
  //    collision this script must never merge (two customers' aliases/margins/assignments
  //    silently folding into one is exactly the corruption this refuses to create).
  if (!has(customers, oldSlug)) errors.push(`customers: no key '${oldSlug}' - nothing to rename (already migrated?)`);
  if (has(customers, newSlug)) errors.push(`customers: key '${newSlug}' already exists - refusing to merge two customers`);
  if (errors.length) return { changes, errors };

  changes.push({ file: 'customers.json', kind: 'key-rename', from: oldSlug, to: newSlug, detail: `label "${customers[oldSlug].label}"` });
  changes.push({ file: 'customers.json', kind: 'field-rewrite', from: `customerId: ${oldSlug}`, to: `customerId: ${newSlug}`, detail: 'doc field mirrors the key' });
  changes.push({ file: 'customers.json', kind: 'field-rewrite', from: 'previousIds', to: `+ '${oldSlug}'`, detail: 'compat trail for stale URLs/params (getByAnyId)' });

  // -- assignments.json: composite keys `${personId}::${customerId}` + the two doc fields.
  for (const key of Object.keys(assignments || {})) {
    const doc = assignments[key];
    const refs = (doc && doc.customerId === oldSlug) || key.endsWith(`::${oldSlug}`);
    if (!refs) continue;
    const personId = (doc && doc.personId) || key.slice(0, key.lastIndexOf('::'));
    const newKey = `${personId}::${newSlug}`;
    if (has(assignments, newKey)) { errors.push(`assignments: target key '${newKey}' already exists - refusing to overwrite`); continue; }
    changes.push({ file: 'assignments.json', kind: 'key-rename', from: key, to: newKey, detail: `person ${personId}` });
    changes.push({ file: 'assignments.json', kind: 'field-rewrite', from: `customerId/assignmentId: ...${oldSlug}`, to: `...${newSlug}`, detail: `doc ${key}` });
  }

  // -- priceRequests.json: keys are tokens (never move); rewrite the two slug-bearing doc
  //    fields so the /price band pill and the link slug stop naming the retired id.
  for (const token of Object.keys(priceRequests || {})) {
    const doc = priceRequests[token];
    if (!doc || typeof doc !== 'object') continue;
    const ms = String(doc.marginSource || '');
    if (ms === `customer:${oldSlug}` || (ms.startsWith('assignment:') && ms.endsWith(`::${oldSlug}`))) {
      const newMs = ms === `customer:${oldSlug}` ? `customer:${newSlug}` : ms.slice(0, -oldSlug.length) + newSlug;
      changes.push({ file: 'priceRequests.json', kind: 'field-rewrite', from: `marginSource: ${ms}`, to: newMs, detail: `request ${token} (load ${doc.loadId || '?'})` });
    }
    if (doc.customer && doc.customer.customerId === oldSlug) {
      changes.push({ file: 'priceRequests.json', kind: 'field-rewrite', from: `customer.customerId: ${oldSlug}`, to: newSlug, detail: `request ${token} (link-slug snapshot)` });
    }
  }

  // -- marginProfiles.json (legacy, kept for rollback): keys `${platformKey}:${customerKey}`.
  for (const key of Object.keys(marginProfiles || {})) {
    const doc = marginProfiles[key];
    const i = key.lastIndexOf(`:${oldSlug}`);
    const keyMatches = i > 0 && i === key.length - oldSlug.length - 1;
    if (!keyMatches && !(doc && doc.customerKey === oldSlug)) continue;
    const platform = keyMatches ? key.slice(0, i) : (doc.platformKey || 'sp');
    const newKey = `${platform}:${newSlug}`;
    if (has(marginProfiles, newKey)) { errors.push(`marginProfiles: target key '${newKey}' already exists - refusing to overwrite`); continue; }
    changes.push({ file: 'marginProfiles.json', kind: 'key-rename', from: key, to: newKey, detail: 'legacy store (kept for rollback)' });
    changes.push({ file: 'marginProfiles.json', kind: 'field-rewrite', from: `customerKey: ${oldSlug}`, to: newSlug, detail: `doc ${key} (customerLabel untouched)` });
  }

  return { changes, errors };
}

/** Apply the rename to the in-memory maps (mutates copies handed in). Mirrors planRename 1:1. */
function applyToMaps({ customers, assignments, priceRequests, marginProfiles }, oldSlug, newSlug) {
  // customers: move key, rewrite id, append the compat trail (deduped, never self-referential).
  const cust = customers[oldSlug];
  delete customers[oldSlug];
  cust.customerId = newSlug;
  const prev = Array.isArray(cust.previousIds) ? cust.previousIds : [];
  cust.previousIds = [...new Set([...prev, oldSlug])].filter((s) => s !== newSlug);
  customers[newSlug] = cust;

  for (const key of Object.keys(assignments || {})) {
    const doc = assignments[key];
    if (!((doc && doc.customerId === oldSlug) || key.endsWith(`::${oldSlug}`))) continue;
    const personId = (doc && doc.personId) || key.slice(0, key.lastIndexOf('::'));
    delete assignments[key];
    doc.customerId = newSlug;
    doc.assignmentId = `${personId}::${newSlug}`;
    assignments[doc.assignmentId] = doc;
  }

  for (const token of Object.keys(priceRequests || {})) {
    const doc = priceRequests[token];
    if (!doc || typeof doc !== 'object') continue;
    const ms = String(doc.marginSource || '');
    if (ms === `customer:${oldSlug}`) doc.marginSource = `customer:${newSlug}`;
    else if (ms.startsWith('assignment:') && ms.endsWith(`::${oldSlug}`)) doc.marginSource = ms.slice(0, -oldSlug.length) + newSlug;
    if (doc.customer && doc.customer.customerId === oldSlug) doc.customer.customerId = newSlug;
  }

  for (const key of Object.keys(marginProfiles || {})) {
    const doc = marginProfiles[key];
    const i = key.lastIndexOf(`:${oldSlug}`);
    const keyMatches = i > 0 && i === key.length - oldSlug.length - 1;
    if (!keyMatches && !(doc && doc.customerKey === oldSlug)) continue;
    const platform = keyMatches ? key.slice(0, i) : (doc.platformKey || 'sp');
    delete marginProfiles[key];
    if (doc && typeof doc === 'object') doc.customerKey = newSlug;
    marginProfiles[`${platform}:${newSlug}`] = doc;
  }
}

function main() {
  const { oldSlug, newSlug, apply, dataDir: dirArg } = parseArgs(process.argv.slice(2));
  // Default matches src/config.js's data dir (repo-root ./data unless SP_DATA_DIR points away).
  const dataDir = path.resolve(dirArg || process.env.SP_DATA_DIR || path.join(__dirname, '..', 'data'));

  if (oldSlug === newSlug) { console.error('old and new slug are identical - nothing to do'); process.exit(2); }
  if (!SLUG_RE.test(newSlug)) { console.error(`new slug '${newSlug}' is not a valid customerId slug (lowercase a-z0-9-, max 40, no edge dashes)`); process.exit(2); }
  if (!fs.existsSync(dataDir)) { console.error(`data dir not found: ${dataDir}`); process.exit(2); }

  // Read all four slug-bearing collections. A missing file is an empty collection, same as
  // FileStore._coll() treats it - a box that never had legacy marginProfiles still migrates.
  const FILES = ['customers.json', 'assignments.json', 'priceRequests.json', 'marginProfiles.json'];
  const p = (f) => path.join(dataDir, f);
  const maps = {
    customers: readJSON(p('customers.json'), {}) || {},
    assignments: readJSON(p('assignments.json'), {}) || {},
    priceRequests: readJSON(p('priceRequests.json'), {}) || {},
    marginProfiles: readJSON(p('marginProfiles.json'), {}) || {},
  };

  const { changes, errors } = planRename(maps, oldSlug, newSlug);
  console.log(`migrate-customer-slugs: ${oldSlug} -> ${newSlug}`);
  console.log(`data dir: ${dataDir}`);
  console.log(`mode: ${apply ? 'APPLY' : 'DRY-RUN (no writes; pass --apply to execute)'}\n`);

  if (errors.length) {
    console.error('REFUSING to run - the plan does not validate:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const byFile = new Map();
  for (const c of changes) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file).push(c);
  }
  for (const f of FILES) {
    const list = byFile.get(f) || [];
    console.log(`${f}: ${list.length ? `${list.length} change(s)` : 'no changes'}`);
    for (const c of list) console.log(`  [${c.kind}] ${c.from} -> ${c.to}  (${c.detail})`);
  }
  console.log(`\ntotal: ${changes.length} change(s) across ${byFile.size} file(s)`);

  if (!apply) { console.log('\ndry-run complete - nothing written.'); return; }

  // ---- APPLY: backup every touched file, write all, roll back everything on any failure ----
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'); // filesystem-safe timestamp
  const touched = FILES.filter((f) => byFile.has(f));
  const backups = [];
  for (const f of touched) {
    if (!fs.existsSync(p(f))) continue; // a collection that only exists in-plan as empty
    const bak = `${p(f)}.bak.${stamp}`;
    fs.copyFileSync(p(f), bak);
    backups.push({ file: p(f), bak });
    console.log(`\nbackup: ${f} -> ${path.basename(bak)}`);
  }

  applyToMaps(maps, oldSlug, newSlug);

  const written = [];
  try {
    for (const f of touched) {
      const key = f.replace('.json', '');
      writeJSONAtomic(p(f), maps[key]);
      written.push(f);
      console.log(`wrote: ${f}`);
    }
  } catch (err) {
    console.error(`\nWRITE FAILED on ${touched[written.length]}: ${err.message}`);
    console.error('rolling back every file written this run from its backup...');
    for (const b of backups) {
      try { fs.copyFileSync(b.bak, b.file); } catch (e) { console.error(`  ROLLBACK FAILED for ${b.file}: ${e.message} - restore manually from ${b.bak}`); }
    }
    process.exit(1);
  }

  // Audit trail: same configChanges stream the console's customer/margin edits record to
  // (FileStore appends day-sharded JSONL under <dataDir>/logs).
  try {
    const day = new Date().toISOString().slice(0, 10);
    appendJSONL(path.join(dataDir, 'logs', `configChanges-${day}.jsonl`), {
      ts: Date.now(), action: 'customer_slug_migrate', by: 'scripts/migrate-customer-slugs.js',
      summary: `customerId rename ${oldSlug} -> ${newSlug}`,
      detail: { oldSlug, newSlug, changes: changes.length, files: touched, backupStamp: stamp },
    });
  } catch (e) { console.error(`audit append failed (rename itself is complete): ${e.message}`); }

  console.log(`\napply complete: ${changes.length} change(s), backups at *.bak.${stamp}`);
  console.log('remember: restart the server (or touch any customer in the console) so the cached model snapshot refreshes.');
}

main();
