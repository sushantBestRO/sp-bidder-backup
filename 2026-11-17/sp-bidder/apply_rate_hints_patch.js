'use strict';
// Wires the optional "Last quote" / "FR8 guide" lines into the price_needed ask.
// Edits two files (backups are saved first): src/notify/waTemplates.js and src/notify/notifier.js.
// Safe to run twice. With both switches off (the default) the ask is byte-for-byte what it was.
// Run from the sp-bidder folder:  node apply_rate_hints_patch.js
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || process.cwd();
const W = path.join(ROOT, 'src/notify/waTemplates.js');
const N = path.join(ROOT, 'src/notify/notifier.js');
const need = [path.join(ROOT, 'src/notify/rateHints.js'), W, N];
for (const f of need) if (!fs.existsSync(f)) { console.error('Missing file:', f, '\nCopy rateHints.js into src/notify/ first.'); process.exit(1); }

let w = fs.readFileSync(W, 'utf8');
let n = fs.readFileSync(N, 'utf8');
if (w.includes('rateHintLines') && n.includes("require('./rateHints')")) { console.log('Already patched - nothing to do.'); process.exit(0); }
if (w.includes('rateHintLines') !== n.includes("require('./rateHints')")) { console.error('Only one of the two files is patched - restore both from their .bak files and run again.'); process.exit(1); }

const eolW = w.includes('\r\n') ? '\r\n' : '\n';
const eolN = n.includes('\r\n') ? '\r\n' : '\n';

const bodyOld = '{{5}}{{12}}\\n⏰ {{6}}{{11}}{{7}}';
const bodyNew = '{{5}}{{12}}{{13}}\\n⏰ {{6}}{{11}}{{7}}';
const phOld = 'closeRuleCell(d), pmtNoteLine(d)] },';
const phNew = 'closeRuleCell(d), pmtNoteLine(d), rateHintLines(d)] },';
const fnAnchor = '/** kind + payload -> the full message string to send; null if the kind is unknown. */';
const fnNew = [
  '// Optional rate hints under the vehicle line (src/notify/rateHints.js): the newest closed quote on this lane',
  '// and vehicle, and FR8\'s published guide for it. Display only - nothing reads them back. Returns \'\' when no',
  '// hints were attached, so the ask is byte-identical while both switches (RATE_LINE_*) are off.',
  'function rateHintLines(d) {',
  '  const h = d && d.rateHints;',
  '  if (!h || typeof h !== \'object\') return \'\';',
  '  let out = \'\';',
  '  const q = h.lastQuote;',
  '  if (q && typeof q === \'object\') {',
  '    const when = q.at != null ? (typeof q.at === \'number\' ? fmtQDate(q.at) : String(q.at)) : \'\';',
  '    const meta = [q.rank != null ? `Rank ${q.rank}` : \'\', when.split(\' \')[0]].filter(Boolean).join(\' | \');',
  '    out += `\\n💵 *Last quote* - ${quoteAmount(q)}${meta ? `\\n🏅 ${meta}` : \'\'}`;',
  '  }',
  '  const f = h.fr8;',
  '  if (f && f.rate != null && Number.isFinite(Number(f.rate))) {',
  '    const range = f.low != null && f.high != null ? ` (₹${fmtNum(f.low)}–${fmtNum(f.high)})` : \'\';',
  '    out += `\\n📊 *FR8 guide* - ${f.approx ? \'~\' : \'\'}₹${fmtNum(f.rate)}${range}`;',
  '  }',
  '  return out;',
  '}',
  '',
  '',
].join(eolW);

const nOld = ['data.accountLabel = request.account.label;', '    }', '    return data;', '  }'].join(eolN);
const nNew = [
  'data.accountLabel = request.account.label;',
  '    }',
  '    // Optional rate hints (last quote on this lane + FR8 guide). Display only; reads a local file, never the',
  '    // network; both switches default OFF; any failure just leaves the lines out and never blocks the ask.',
  '    try {',
  '      const hints = require(\'./rateHints\').hintsFor(request, data);',
  '      if (hints) data.rateHints = hints;',
  '    } catch (e) { this.log(`[notify] rate hints skipped for ${request.loadId}: ${e && e.message}`); }',
  '    return data;',
  '  }',
].join(eolN);

const count = (s, sub) => s.split(sub).length - 1;
for (const [label, text, sub] of [['template body', w, bodyOld], ['template placeholders', w, phOld], ['template helper anchor', w, fnAnchor], ['notifier', n, nOld]]) {
  if (count(text, sub) !== 1) { console.error(`Cannot patch: the ${label} text was not found exactly once - this server.js/notifier differs from the version I checked. Nothing was changed.`); process.exit(1); }
}

const stamp = Date.now();
fs.copyFileSync(W, `${W}.bak-${stamp}`);
fs.copyFileSync(N, `${N}.bak-${stamp}`);
w = w.replace(bodyOld, () => bodyNew).replace(phOld, () => phNew).replace(fnAnchor, () => fnNew + fnAnchor);
n = n.replace(nOld, () => nNew);
fs.writeFileSync(W, w);
fs.writeFileSync(N, n);
console.log('Patched waTemplates.js and notifier.js. Backups: *.bak-' + stamp);
console.log('Both lines are OFF until you set RATE_LINE_LAST_QUOTE=1 and/or RATE_LINE_FR8=1 in .env and restart.');
