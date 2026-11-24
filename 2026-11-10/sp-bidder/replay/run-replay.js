'use strict';
/**
 * Baseline replay run — the CLI that produces the behavioural report.
 *
 *   node replay/run-replay.js                 full report to stdout
 *   node replay/run-replay.js --json          machine-readable summary instead
 *   node replay/run-replay.js --limit 50      cap auctions per cohort (default: all extended ones)
 *
 * Deterministic: same corpus in, byte-identical output out. No wall-clock read reaches the report.
 *
 * READ replay/README.md BEFORE INTERPRETING ANY NUMBER HERE. In particular: nothing in this report
 * is a win rate, a clearing price, or a counterfactual outcome, because SuperProcure masks external
 * competitor bid amounts and the GoComet logs are BRL's own bot's output. Every figure is
 * behavioural — did the engine fire, when, within budget, within its constraints.
 */
// Silence the engine's own logger before anything pulls it in: it writes JSON lines carrying
// WALL-CLOCK timestamps to stdout, which would both corrupt the report and make it differ on
// every run — the opposite of what a diffable baseline needs.
process.env.LOG_LEVEL = 'silent';

const { loadGocometCorpus, loadSpCapture, dataRoot } = require('./lib/corpus');
const { reconstructCorpus, summarise, DEFAULTS: RECON } = require('./lib/reconstruct');
const { buildSpScenario, censusByCloseModel, readCloseModel } = require('./lib/spScenario');
const { ReplayHarness } = require('./lib/harness');
const { summariseRun, aggregate, compareRevisionPolicies } = require('./lib/metrics');
const { createSpEngineDriver, cleanup } = require('./drivers/spEngineDriver');
const R = require('./lib/report');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
}
const WANT_JSON = process.argv.includes('--json');
const LIMIT = Number(arg('--limit', '0')) || 0;

function main() {
  const out = [];
  const jsonOut = {};

  // ---------------------------------------------------------------- corpora
  const corpusNames = ['gocomet-dead', 'gocomet-live'];
  const corpora = corpusNames.map((n) => loadGocometCorpus(n));
  const sp = loadSpCapture();

  // A replay RUN against a missing corpus is a HARD ERROR (see the contract in replay/lib/corpus.js).
  // Without this, an empty run prints the corpus table showing all NO, produces zero metrics, and
  // exits 0 — indistinguishable from "ran clean, all metrics zero".
  if (!corpora.some((c) => c.available) && !sp.available) {
    process.stderr.write(
      'replay: no corpus available — nothing to replay.\n'
      + `  looked under: ${dataRoot()}\n`
      + '  set REPLAY_CORPUS_ROOT to the directory that holds the corpora (see replay/lib/corpus.js).\n');
    cleanup();
    process.exit(1);
  }

  out.push(R.renderCorpusSection(corpora));
  out.push(`\nSuperProcure capture: ${sp.available ? `${sp.loads.length} distinct loads across ${sp.accounts.filter((a) => a.present).length} account payloads` : 'NOT AVAILABLE'}`);
  if (sp.available) {
    const cos = new Set(sp.ownBids.map((b) => b.companyName));
    out.push(`  own bidDetails rows: ${sp.ownBids.length} (${[...cos].sort().join(', ') || '(none)'}); foreign rows: ${sp.foreignBidCount}`);
    if (sp.foreignBidCount === 0) {
      out.push('  ^ every row is BRL\'s own account. This is the empirical proof that SP masks external');
      out.push('    competitor amounts, and therefore why no counterfactual number appears in this report.');
    } else {
      out.push(`  ^ WARNING: ${sp.foreignBidCount} foreign bidDetails row(s) present (${sp.foreignCompanies.join(', ')}).`);
      out.push('    The "SP masks external amounts" assumption does NOT hold for this capture. Those rows');
      out.push('    were dropped at the loader, but the discrepancy must be understood before any number');
      out.push('    below is trusted.');
    }
  }
  jsonOut.corpora = corpora.map((c) => ({ name: c.name, available: c.available, files: c.files.length, records: c.records.length, recordsLost: c.recordsLost }));

  // ---------------------------------------------------- reconstruction
  const recon = [];
  for (const c of corpora) {
    if (!c.available) continue;
    const auctions = reconstructCorpus(c.records);
    recon.push({ name: c.name, auctions, summary: summarise(auctions) });
  }
  if (recon.length) {
    out.push(R.renderReconstructionSection(recon, RECON));
    jsonOut.reconstruction = recon.map((e) => ({ name: e.name, summary: e.summary }));
  }

  // ---------------------------------------------------- SP close-model census
  if (sp.available) {
    out.push(R.h1('3. SUPERPROCURE — declared close model per customer (2026-07-13 capture)'));
    out.push('One row per distinct close CONFIGURATION, not per company - a customer can carry');
    out.push('several across its branches, and grouping by name hides exactly that.');
    out.push('');
    const census = censusByCloseModel(sp.loads);
    out.push(R.table(
      ['company', 'loads', 'branches', 'extendTime', 'extendOn', 'maxRounds', 'PLATFORM behaviour', 'extendTime-only read'],
      census.map((e) => [
        e.company, e.loads, e.branches,
        e.extendSeconds ? `${e.extendSeconds}s` : '0',
        e.extendEnabled ? 'yes' : 'NO',
        e.extendCount == null ? '-' : e.extendCount,
        e.actuallySoftCloses ? 'SOFT' : 'hard',
        e.softByExtendTimeAlone ? 'soft' : 'hard',
      ]),
      ['l', 'r', 'r', 'r', 'l', 'r', 'l', 'l'],
    ));
    const trap = census.filter((e) => e.extendTimeSetButExtensionOff);
    if (trap.length) {
      out.push('');
      out.push('DISAGREEMENT between the two reads (finding F1):');
      for (const t of trap) {
        out.push(`  ${t.company}: ${t.loads} load(s) with branchAuctionExtendTime=${t.extendSeconds}s but branchExtendAuction=0`);
        out.push(`    load ids: ${t.loadIds.join(', ')}`);
        out.push('    -> the platform will NEVER extend these, but a check reading only the extend');
        out.push('       time classifies them soft-close.');
      }
    } else {
      out.push('\nNo extendTime/extendOn disagreement in this capture.');
    }
    jsonOut.spCensus = census;
  }

  // ---------------------------------------------------- replay: GoComet timelines
  const harness = new ReplayHarness();
  const cohorts = [];

  for (const entry of recon) {
    // The auctions worth replaying for extension-war behaviour are the ones that actually
    // extended. Selection is deterministic: filter, then sort by the same total key the
    // reconstruction already applied.
    let extended = entry.auctions.filter((a) => a.confirmedExtensions > 0);
    if (LIMIT) extended = extended.slice(0, LIMIT);
    if (!extended.length) continue;

    for (const policy of ['no-reset', 'reset-per-round']) {
      const summaries = [];
      for (const a of extended) {
        const cost = a.pricing && a.pricing.marketValue != null ? a.pricing.marketValue : null;
        if (cost == null) continue;   // no own-pricing context -> no honest cost basis -> skip
        const driver = createSpEngineDriver({
          name: `sp-bidEngine/${policy}`,
          companyName: 'Havells',
          cost,
          marginsPct: [12.6, 7.2, 6.3],
        });
        const run = harness.run(a, driver, {
          floor: cost,
          revisionLimit: 3,             // GoComet's documented budget
          revisionPolicy: policy,
          extendMs: 300_000,
          extendCount: null,            // GoComet exposes no counter
        });
        summaries.push(summariseRun(run, a));
      }
      if (summaries.length) cohorts.push({ corpus: entry.name, policy, summaries, agg: aggregate(summaries) });
    }
  }

  if (cohorts.length) {
    out.push(R.h1('4. REPLAY — production SP engine against reconstructed GoComet extension wars'));
    out.push('The SuperProcure soft-close engine driven through GoComet timelines. This is a');
    out.push('CROSS-PLATFORM probe: it shows how the existing engine behaves against the extension');
    out.push('depth GoComet actually produces, which is the gap the new GoComet engine must close.');
    for (const c of cohorts) {
      out.push(R.renderRunSection(`${c.corpus} | revision policy: ${c.policy}`, c.agg, c.summaries));
    }

    out.push(R.h1('5. REVISION-BUDGET POLICY — behavioural difference between the two assumptions'));
    for (const name of recon.map((e) => e.name)) {
      const nr = cohorts.find((c) => c.corpus === name && c.policy === 'no-reset');
      const rs = cohorts.find((c) => c.corpus === name && c.policy === 'reset-per-round');
      if (!nr || !rs) continue;
      const cmp = compareRevisionPolicies(nr.summaries, rs.summaries);
      out.push(R.h2(name));
      out.push(R.table(['metric', 'no-reset', 'reset-per-round'], [
        ['auctions', cmp.pairedAuctions, cmp.pairedAuctions],
        ['bids placed', cmp.bidsNoReset, cmp.bidsReset],
        ['budget exhausted', cmp.exhaustedNoReset, cmp.exhaustedReset],
        ['survived to final round', cmp.survivedNoReset, cmp.survivedReset],
      ], ['l', 'r', 'r']));
      out.push(`\ndivergent auctions: ${cmp.divergentAuctions} / ${cmp.pairedAuctions} (${cmp.divergentPct}%)`);
      jsonOut[`policyCompare_${name}`] = cmp;
    }
  }

  // ---------------------------------------------------- replay: SP scenarios
  if (sp.available) {
    const scenarios = [];
    for (const L of sp.loads) {
      const cm = readCloseModel(L);
      if (!cm.softByExtendTimeAlone) continue;    // hard-close loads are covered by the census
      const s = buildSpScenario(L);
      if (s) scenarios.push(s);
    }
    if (scenarios.length) {
      const summaries = [];
      const MARGINS = [12.6, 7.2, 6.3];
      for (const s of scenarios) {
        // COST BASIS IS A HARNESS ASSUMPTION, NOT A RECOVERED FACT. The SP capture does not
        // contain BRL's cost for these lanes. So the ladder is anchored to the load's own binding
        // upper bound — its published ceilingPrice when it has one, otherwise SP's lane-average
        // freight — and cost is set so the TOP rung lands exactly on that anchor.
        //
        // Anchoring matters: a first pass used lane-average freight as cost and added 12.6%, which
        // put every rung above the shipper's published ceiling on 14 Shriji loads. The engine then
        // looked "silent" on all 14. It was not — every bid was rejected above_ceiling by the
        // harness. That was a parameterisation artifact, and reporting it as an engine defect
        // would have been a fabricated finding. Silence is now always shown with its cause.
        const anchor = s.limits.ceilingPrice || s.limits.laneFreightFTL || s.limits.laneFreightPMT;
        if (!anchor) continue;
        const cost = Math.round(anchor / (1 + Math.max(...MARGINS) / 100));
        const driver = createSpEngineDriver({
          name: 'sp-bidEngine',
          companyName: s.companyName || 'Havells',
          cost,
          marginsPct: MARGINS,
        });
        const run = harness.run(s, driver, { floor: cost, revisionPolicy: 'no-reset' });
        const topReason = Object.entries(run.rejections.reduce((m, r) => {
          m[r.reason] = (m[r.reason] || 0) + 1; return m;
        }, {})).sort((a, b) => b[1] - a[1])[0];
        summaries.push(Object.assign(summariseRun(run, s), {
          _company: s.companyName, _scriptedRounds: s.scriptedRounds, _softReal: s.closeModel.actuallySoftCloses,
          _capUnknown: s.capUnknown,
          _whyNot: [
            // A SOFT-on-platform load with an unknown extension cap is scripted with 0 rounds; say so
            // explicitly rather than letting it read as a hard-close replay of a SOFT load.
            s.capUnknown ? 'cap unknown: SOFT on platform, scripted 0 rounds' : '',
            run.bids.length ? '' : (topReason ? `${topReason[0]} x${topReason[1]}` : 'no decision returned'),
          ].filter(Boolean).join('; '),
        }));
      }
      if (summaries.length) {
        out.push(R.h1('6. REPLAY — production SP engine against real SP loads (declared-parameter scenarios)'));
        out.push('These are REAL loads with their own declared close parameters. Extension ROUNDS are');
        out.push('SCRIPTED, not observed — no per-tick SP timeline exists locally. Read accordingly.');
        out.push('');
        out.push('Cost basis is a HARNESS ASSUMPTION (the capture has no BRL cost): the ladder is');
        out.push('anchored so its top rung lands on the load\'s ceilingPrice, or on SP\'s lane-average');
        out.push('freight when the load publishes no ceiling. The "why not" column explains every');
        out.push('silence, so a parameterisation artifact can never be mistaken for engine behaviour.');
        out.push('');
        out.push(R.table(
          ['load', 'company', 'platform soft?', 'rounds', 'fired', 'bids', 'last fire', 'why not'],
          summaries.map((s) => [
            s.auctionId, s._company, s._softReal ? 'SOFT' : 'hard (extendTime set, extend OFF)',
            s._scriptedRounds, s.fired ? 'yes' : 'NO', s.bidCount,
            R.fmtMs(s.timing.lastFireMsBeforeFinalClose), s._whyNot || '',
          ]),
          ['l', 'l', 'l', 'r', 'l', 'r', 'r', 'l'],
        ));
        jsonOut.spScenarios = summaries.map((s) => ({
          id: s.auctionId, company: s._company, softReal: s._softReal,
          rounds: s._scriptedRounds, fired: s.fired, bids: s.bidCount,
        }));
      }
    }
  }

  cleanup();

  if (WANT_JSON) {
    process.stdout.write(JSON.stringify(jsonOut, null, 2) + '\n');
  } else {
    process.stdout.write(out.join('\n') + '\n');
  }
}

if (require.main === module) {
  try { main(); } catch (e) { cleanup(); console.error('replay failed:', e && e.stack || e); process.exit(1); }
}

module.exports = { main };
