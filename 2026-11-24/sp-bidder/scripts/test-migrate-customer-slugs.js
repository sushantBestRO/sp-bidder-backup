'use strict';

/**
 * scripts/migrate-customer-slugs.js - the slug-rename migration, exercised end-to-end against
 * throwaway fixture files (never the repo's real data/). Asserts:
 *   - DRY-RUN (the default) prints the plan and writes NOTHING - files stay byte-identical,
 *     no backup files appear;
 *   - --apply renames the key in EVERY store that holds the slug (customers key + doc field,
 *     assignments composite keys + both doc fields, priceRequests marginSource + customer
 *     snapshot, legacy marginProfiles key + customerKey) and touches nothing else;
 *   - --apply writes a timestamped .bak of every touched file whose content is the ORIGINAL;
 *   - the customers doc gains previousIds [old] and CustomerStore.getByAnyId resolves the
 *     retired slug to the renamed doc - and an ordinary upsert round-trip PRESERVES the trail
 *     (validateCustomer must not drop it);
 *   - a second --apply refuses (old key gone), a target-key collision refuses with no writes,
 *     and a malformed new slug refuses - all non-zero exits.
 */

const os = require('os');
const fs = require('fs'); // allowed: test harness (fixture files), not app state
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'migrate-customer-slugs.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// ---- fixtures: the borocil shape observed on the live box (label already clean, key not) ----
const FIXTURES = {
  'customers.json': {
    borocil: {
      customerId: 'borocil', label: 'Borosil',
      aliases: ['Borosil', 'BG', 'BorosilLimited'],
      margin: { marginsPct: [10, 8, 6], minMarginPct: 6 }, auction: null, enabled: true,
    },
    syngenta: { customerId: 'syngenta', label: 'Syngenta', aliases: ['Syngenta'], margin: null, auction: null, enabled: true },
  },
  'assignments.json': {
    'p919000000001::borocil': { assignmentId: 'p919000000001::borocil', personId: 'p919000000001', customerId: 'borocil', lanes: null, marginOverride: null, alertKinds: null, enabled: true },
    'g120363410658010519::borocil': { assignmentId: 'g120363410658010519::borocil', personId: 'g120363410658010519', customerId: 'borocil', lanes: null, marginOverride: null, alertKinds: null, enabled: true },
    'p919000000001::syngenta': { assignmentId: 'p919000000001::syngenta', personId: 'p919000000001', customerId: 'syngenta', lanes: null, marginOverride: null, alertKinds: null, enabled: true },
  },
  'priceRequests.json': {
    Tok1CustomerA: { id: 'Tok1CustomerA', loadId: '101', status: 'awaiting_price', marginSource: 'customer:borocil', customer: { customerId: 'borocil', label: 'Borosil' }, load: { companyName: 'BG (BorosilLimited(Govindgarh))' } },
    Tok2AssignmtB: { id: 'Tok2AssignmtB', loadId: '102', status: 'armed', marginSource: 'assignment:p919000000001::borocil', customer: null, load: { companyName: 'BG (BorosilLimited(Govindgarh))' } },
    Tok3UntouchdC: { id: 'Tok3UntouchdC', loadId: '103', status: 'closed', marginSource: 'default', customer: { customerId: 'syngenta', label: 'Syngenta' }, load: { companyName: 'Syngenta' } },
  },
  'marginProfiles.json': {
    'sp:borocil': { platformKey: 'sp', customerKey: 'borocil', customerLabel: 'Borosil', marginsPct: [10, 8, 6], minMarginPct: 6, enabled: true },
  },
};

function freshDir(extraCustomers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-slug-mig-'));
  for (const [f, v] of Object.entries(FIXTURES)) {
    const val = f === 'customers.json' && extraCustomers ? { ...v, ...extraCustomers } : v;
    fs.writeFileSync(path.join(dir, f), JSON.stringify(val, null, 2));
  }
  return dir;
}
const readMap = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const run = (dir, args) => spawnSync(process.execPath, [SCRIPT, ...args, `--data-dir=${dir}`], { encoding: 'utf8' });
const baks = (dir) => fs.readdirSync(dir).filter((f) => f.includes('.bak.'));

(async () => {
  // ---- dry-run: full plan printed, zero writes -----------------------------------------------
  const d1 = freshDir();
  const before = Object.fromEntries(Object.keys(FIXTURES).map((f) => [f, fs.readFileSync(path.join(d1, f), 'utf8')]));
  const dry = run(d1, ['borocil', 'borosil']);
  ok(dry.status === 0, `dry-run exits 0 (got ${dry.status}: ${dry.stderr})`);
  ok(/DRY-RUN/.test(dry.stdout), 'dry-run announces itself');
  ok(/customers\.json: 3 change/.test(dry.stdout), 'plan covers the customers store');
  ok(/p919000000001::borocil -> p919000000001::borosil/.test(dry.stdout), 'plan names the person::customer key rename');
  ok(/g120363410658010519::borocil -> g120363410658010519::borosil/.test(dry.stdout), 'plan names the group::customer key rename');
  ok(/marginSource: customer:borocil -> customer:borosil/.test(dry.stdout), 'plan names the marginSource rewrite');
  ok(/sp:borocil -> sp:borosil/.test(dry.stdout), 'plan names the legacy marginProfiles key rename');
  ok(Object.keys(FIXTURES).every((f) => fs.readFileSync(path.join(d1, f), 'utf8') === before[f]), 'dry-run wrote NOTHING (files byte-identical)');
  ok(baks(d1).length === 0, 'dry-run created no backups');

  // ---- apply: every store renamed, everything else untouched, backups hold the originals -----
  const app1 = run(d1, ['borocil', 'borosil', '--apply']);
  ok(app1.status === 0, `apply exits 0 (got ${app1.status}: ${app1.stderr})`);

  const cust = readMap(d1, 'customers.json');
  ok(!cust.borocil && !!cust.borosil, 'customers: key moved borocil -> borosil');
  ok(cust.borosil.customerId === 'borosil', 'customers: doc.customerId rewritten');
  ok(cust.borosil.label === 'Borosil' && cust.borosil.aliases.includes('BG'), 'customers: label + aliases untouched');
  ok(Array.isArray(cust.borosil.previousIds) && cust.borosil.previousIds.includes('borocil'), 'customers: previousIds carries the retired slug');
  ok(!!cust.syngenta && cust.syngenta.customerId === 'syngenta', 'customers: unrelated customer untouched');

  const asg = readMap(d1, 'assignments.json');
  ok(!asg['p919000000001::borocil'] && !!asg['p919000000001::borosil'], 'assignments: person composite key moved');
  ok(!asg['g120363410658010519::borocil'] && !!asg['g120363410658010519::borosil'], 'assignments: group composite key moved');
  ok(asg['p919000000001::borosil'].customerId === 'borosil' && asg['p919000000001::borosil'].assignmentId === 'p919000000001::borosil', 'assignments: both doc fields rewritten');
  ok(!!asg['p919000000001::syngenta'], 'assignments: unrelated assignment untouched');

  const prq = readMap(d1, 'priceRequests.json');
  ok(prq.Tok1CustomerA.marginSource === 'customer:borosil', 'priceRequests: customer: marginSource rewritten');
  ok(prq.Tok1CustomerA.customer.customerId === 'borosil' && prq.Tok1CustomerA.customer.label === 'Borosil', 'priceRequests: link-slug snapshot rewritten, label kept');
  ok(prq.Tok2AssignmtB.marginSource === 'assignment:p919000000001::borosil', 'priceRequests: assignment: marginSource rewritten');
  ok(prq.Tok3UntouchdC.marginSource === 'default' && prq.Tok3UntouchdC.customer.customerId === 'syngenta', 'priceRequests: unrelated request untouched');
  ok(prq.Tok1CustomerA.load.companyName === 'BG (BorosilLimited(Govindgarh))', 'priceRequests: raw companyName snapshot untouched (routing key)');

  const mpr = readMap(d1, 'marginProfiles.json');
  ok(!mpr['sp:borocil'] && !!mpr['sp:borosil'], 'marginProfiles: legacy composite key moved');
  ok(mpr['sp:borosil'].customerKey === 'borosil' && mpr['sp:borosil'].customerLabel === 'Borosil', 'marginProfiles: customerKey rewritten, customerLabel untouched');

  const bakFiles = baks(d1);
  ok(bakFiles.length === 4, `apply backed up all 4 touched files (got ${bakFiles.length})`);
  const custBak = bakFiles.find((f) => f.startsWith('customers.json.bak.'));
  ok(!!custBak && fs.readFileSync(path.join(d1, custBak), 'utf8') === before['customers.json'], 'backup holds the ORIGINAL (pre-rename) customers content');

  // audit trail landed on the configChanges stream
  const day = new Date().toISOString().slice(0, 10);
  const auditPath = path.join(d1, 'logs', `configChanges-${day}.jsonl`);
  ok(fs.existsSync(auditPath) && /customer_slug_migrate/.test(fs.readFileSync(auditPath, 'utf8')), 'apply recorded a configChanges audit event');

  // ---- the compat seam the rename depends on: getByAnyId + previousIds round-trip ------------
  const { FileStore } = require('../src/store/fileStore');
  const { CustomerStore } = require('../src/model/customerStore');
  const cs = new CustomerStore({ store: new FileStore({ dataDir: d1 }) });
  const viaOld = await cs.getByAnyId('borocil');
  ok(!!viaOld && viaOld.customerId === 'borosil', 'getByAnyId resolves the RETIRED slug to the renamed customer');
  const viaNew = await cs.getByAnyId('borosil');
  ok(!!viaNew && viaNew.customerId === 'borosil', 'getByAnyId still resolves the current slug directly');
  // an ordinary console-style edit must not shed the compat trail
  const edited = await cs.upsert({ ...viaNew, label: 'Borosil Ltd' });
  ok(Array.isArray(edited.previousIds) && edited.previousIds.includes('borocil'), 'upsert round-trip PRESERVES previousIds (validateCustomer carries it)');

  // ---- refusals: second apply, collision, malformed new slug ---------------------------------
  const again = run(d1, ['borocil', 'borosil', '--apply']);
  ok(again.status !== 0 && /no key 'borocil'/.test(again.stderr), 'second apply refuses: old key already gone');

  const d2 = freshDir({ borosil: { customerId: 'borosil', label: 'Borosil Glass Works', aliases: ['Borosil Glass Works'], margin: null, auction: null, enabled: true } });
  const beforeCollide = fs.readFileSync(path.join(d2, 'customers.json'), 'utf8');
  const collide = run(d2, ['borocil', 'borosil', '--apply']);
  ok(collide.status !== 0 && /already exists/.test(collide.stderr), 'collision refuses: never merges two customers');
  ok(fs.readFileSync(path.join(d2, 'customers.json'), 'utf8') === beforeCollide && baks(d2).length === 0, 'collision refusal wrote nothing and took no backups');

  const badSlug = run(freshDir(), ['borocil', 'Boro sil', '--apply']);
  ok(badSlug.status !== 0, 'malformed new slug refuses');
  const sameSlug = run(freshDir(), ['borocil', 'borocil']);
  ok(sameSlug.status !== 0, 'old === new refuses');

  // ---- induced mid-apply write failure: full rollback, no partial rename left on disk --------
  // This is the one path the rest of the suite never exercises and the entire justification for
  // the script's "all-or-nothing, no partial rename is ever left on disk" guarantee (header + the
  // catch at migrate-customer-slugs.js). --apply writes each touched collection through the store
  // seam's writeJSONAtomic (tmp-write via fs.writeFileSync(<file>.tmp) then rename). The script
  // runs as a spawned subprocess here, so we fault-inject at the filesystem, not by monkeypatch:
  // pre-create a DIRECTORY at the SECOND touched file's tmp path (assignments.json.tmp) so its
  // fs.writeFileSync(<file>.tmp, ...) throws EISDIR - deterministic, cross-platform, and only
  // AFTER customers.json (write #1) has already committed to disk. That reproduces exactly the
  // shape the rollback catch exists to undo: file 1 renamed, file 2 fails, everything must revert.
  const dFail = freshDir();
  const failFiles = Object.keys(FIXTURES);
  const beforeFail = Object.fromEntries(failFiles.map((f) => [f, fs.readFileSync(path.join(dFail, f), 'utf8')]));
  fs.mkdirSync(path.join(dFail, 'assignments.json.tmp')); // the trap: makes the 2nd map write throw
  const failed = run(dFail, ['borocil', 'borosil', '--apply']);
  // (a) the run reports failure, naming the collection whose write threw + announcing the rollback
  ok(failed.status !== 0, `induced write failure exits non-zero (got ${failed.status})`);
  ok(/WRITE FAILED on assignments\.json/.test(failed.stderr), 'induced failure names the collection whose write threw');
  ok(/rolling back/i.test(failed.stderr), 'induced failure announces the rollback');
  // (b) ALL four collections byte-identical to their pre-apply content. customers.json was written
  //     (renamed) first, then the catch restored it from backup - the partial rename must be gone.
  for (const f of failFiles) {
    ok(fs.readFileSync(path.join(dFail, f), 'utf8') === beforeFail[f], `rollback restored ${f} byte-identical to pre-apply`);
  }
  // (c) backups still exist per the script's contract: one .bak per touched file, holding the original.
  const failBaks = baks(dFail);
  ok(failBaks.length === 4, `induced failure still backed up all 4 touched files (got ${failBaks.length})`);
  for (const f of failFiles) {
    const bak = failBaks.find((b) => b.startsWith(`${f}.bak.`));
    ok(!!bak && fs.readFileSync(path.join(dFail, bak), 'utf8') === beforeFail[f], `${f}.bak holds the ORIGINAL pre-apply content`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
