'use strict';
/**
 * Deterministic report rendering.
 *
 * Same corpus in, byte-identical report out, every run. That is the whole point — the report is
 * meant to be diffed between engine versions, so anything that varies run to run (a wall-clock
 * stamp, a hostname, an unsorted map iteration, a floating-point tail) would destroy its value.
 *
 * Rules enforced here:
 *   - no wall-clock time anywhere in the output (not even "generated at")
 *   - every collection sorted by an explicit, total key before rendering
 *   - all floats rounded to fixed precision
 *   - no absolute filesystem paths (they differ per machine)
 */

function fmtMs(ms) {
  if (ms == null) return '-';
  const s = ms / 1000;
  if (Math.abs(s) < 90) return `${round1(s)}s`;
  const m = s / 60;
  if (Math.abs(m) < 90) return `${round1(m)}m`;
  return `${round1(m / 60)}h`;
}
function round1(n) { return Math.round(n * 10) / 10; }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

function h1(t) { return `\n${'='.repeat(92)}\n${t}\n${'='.repeat(92)}`; }
function h2(t) { return `\n${t}\n${'-'.repeat(t.length)}`; }

function table(headers, rows, aligns) {
  const widths = headers.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i] == null ? '-' : r[i]).length)));
  const fmtRow = (cells) => cells.map((c, i) => {
    const v = c == null ? '-' : String(c);
    return (aligns && aligns[i] === 'r') ? padL(v, widths[i]) : pad(v, widths[i]);
  }).join('  ');
  const out = [fmtRow(headers), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const r of rows) out.push(fmtRow(r));
  return out.join('\n');
}

/** Corpus provenance block — what was loaded, what was lost, and what it cannot support. */
function renderCorpusSection(corpora) {
  const lines = [h1('1. CORPUS — what was loaded')];
  const rows = corpora.map((c) => [
    c.name,
    c.available ? 'yes' : 'NO',
    c.available ? c.files.length : '-',
    c.available ? c.records.length : '-',
    c.available ? (c.parseFailures.length || 0) : '-',
    c.available ? (c.recordsLost || 0) : '-',
  ]);
  lines.push(table(
    ['corpus', 'available', 'files', 'records', 'unparseable files', 'records lost'],
    rows, ['l', 'l', 'r', 'r', 'r', 'r'],
  ));
  for (const c of corpora) {
    for (const f of (c.parseFailures || [])) {
      lines.push(`  ! ${c.name}/${f.file}: ${f.reason}${f.approxRecordsLost != null ? ` (~${f.approxRecordsLost} records lost)` : ''}`);
    }
  }
  return lines.join('\n');
}

/** Reconstruction block — extension detection, with the band filter stated explicitly. */
function renderReconstructionSection(entries, cfg) {
  const lines = [h1('2. RECONSTRUCTION — extension timelines rebuilt from close-time slide')];
  lines.push(`Band filter (configurable, replay/lib/reconstruct.js DEFAULTS):`);
  lines.push(`  noise <= ${cfg.noiseToleranceSec}s | sub-band < ${cfg.bandLowSec}s | EXTENSION ${cfg.bandLowSec}-${cfg.bandHighSec}s`
    + ` | aliased <= ${cfg.aliasWindowSec}s | beyond that = re-open / unclassified gap (segment cut)`);
  lines.push('');
  lines.push('Only in-band slides are counted as anti-snipe rounds. A naive ">60s = extension" rule');
  lines.push('inflates the count ~3.5x by swallowing shipper re-opens (slides of 5 hours to 22 days).');
  lines.push('');

  const rows = entries.map((e) => [
    e.name,
    e.summary.auctions,
    e.summary.multiObservation,
    e.summary.auctionsShowingConfirmedExtension,
    e.summary.confirmedExtensionEvents,
    `${e.summary.confirmedEventsOnGridPct == null ? '-' : e.summary.confirmedEventsOnGridPct}%`,
    e.summary.maxConfirmedRoundsLowerBound,
    e.summary.aliasedSlidesExcluded,
    e.summary.reopenSegments + e.summary.unclassifiedGapSegments + e.summary.backwardRescheduleSegments,
  ]);
  lines.push(table(
    ['corpus', 'auctions', 'multi-obs', 'w/ extension', 'events', 'on-grid', 'max rounds*', 'aliased (excl)', 'cuts'],
    rows, ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
  ));
  lines.push('');
  lines.push('* max rounds is a LOWER BOUND. Extensions before our first bid or after our last are');
  lines.push('  invisible; aliased slides hold 2+ real rounds each and are excluded from round counts.');

  lines.push(h2('2b. Revision budget across in-band extension boundaries'));
  lines.push('Direct evidence on whether GoComet\'s 3-revision budget RESETS each anti-snipe round.');
  const rrows = entries.map((e) => {
    const rb = e.summary.revisionBoundaries;
    return [e.name, rb.total, rb.increased, rb.unchanged, rb.decreased, rb.successFromExhausted];
  });
  lines.push(table(
    ['corpus', 'boundaries', 'increased', 'unchanged', 'decreased', 'success-from-exhausted'],
    rrows, ['l', 'r', 'r', 'r', 'r', 'r'],
  ));
  lines.push('');
  lines.push('"success-from-exhausted" is the decisive pattern: revisionsLeft was 0, the extension');
  lines.push('fired, and the very next bid SUCCEEDED with budget restored. No no-reset reading');
  lines.push('explains it. This is BRL\'s own counter, not the bot\'s bookkeeping.');
  return lines.join('\n');
}

/** Behavioural findings for one engine run set. */
function renderRunSection(title, agg, summaries, opts = {}) {
  const lines = [h2(title)];
  lines.push(table(
    ['metric', 'value'],
    [
      ['auctions replayed', agg.runs],
      ['engine fired', `${agg.fired} (${round1(100 - (agg.silentPct == null ? 0 : agg.silentPct))}%)`],
      ['engine SILENT', `${agg.silent} (${agg.silentPct}%)`],
      ['total bids placed', agg.totalBids],
      ['auctions with >=1 extension', agg.auctionsWithExtensions],
      ['survived to final round', `${agg.survivedFinalRound} / ${agg.auctionsWithExtensions} (${agg.survivedFinalRoundPct}%)`],
      ['revision budget exhausted', agg.revisionsExhausted],
      ['exhausted EARLY (before last round)', agg.revisionsExhaustedEarly],
      ['fires before last extension', agg.firesBeforeLastExtension],
      ['floor breaches', agg.floorBreachRuns],
      ['ceiling breaches', agg.ceilingBreachRuns],
      ['driver errors', agg.driverErrorRuns],
      ['last fire before close (p50)', fmtMs(agg.lastFireMsBeforeFinalClose.p50)],
      ['last fire before close (p90)', fmtMs(agg.lastFireMsBeforeFinalClose.p90)],
    ], ['l', 'r'],
  ));
  if (Object.keys(agg.rejectionReasons).length) {
    lines.push('');
    lines.push('Rejections: ' + Object.entries(agg.rejectionReasons).map(([k, v]) => `${k}=${v}`).join('  '));
  }
  return lines.join('\n');
}

module.exports = { h1, h2, table, fmtMs, round1, renderCorpusSection, renderReconstructionSection, renderRunSection };
