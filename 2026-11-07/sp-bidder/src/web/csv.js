'use strict';

/**
 * CSV serialization for the /api/export/* endpoints (docs/CSV_EXPORTS_SCOPE.md).
 *
 * Pure string work — no `fs` — so it lives outside the store seam without tripping
 * the "no fs outside store/" gate. The consumer is an analyst or a model, not the
 * app, so the formatting is deliberately analysis-friendly: timestamps are emitted
 * ISO 8601, arrays are pipe-joined, and a missing value is a blank cell (never the
 * string "null"/"undefined", and never a bare "false" for an unknown boolean).
 */

// A cell that STARTS with a formula trigger executes as a formula when the export is opened in
// Excel / Google Sheets — which the Export page tells the analyst to do (CSV-injection / CWE-1236).
// Untrusted shipper fields (companyName, lane, product), Maytapi error strings, and `+NN` phone
// numbers all reach cells, so a crafted `=IMPORTXML(...)` could exfiltrate adjacent cost/margin
// cells with no prompt. `-`/`+` are included even though it prefixes negative numbers / phone
// numbers with an apostrophe: this export carries no legitimately negative numeric column, and a
// text-typed phone is the safe reading.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

// RFC-4180 field: neutralize a leading formula trigger with an apostrophe, then quote when the
// value contains a comma, quote, CR or LF (doubling any internal quote). Everything else passes
// through as-is.
function csvField(value) {
  if (value == null) return '';
  let s = typeof value === 'string' ? value : String(value);
  if (s === '') return '';
  if (FORMULA_LEAD.test(s)) s = "'" + s; // text-force so the spreadsheet won't evaluate it
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// One CSV line from an array of cells.
function csvRow(cells) { return cells.map(csvField).join(','); }

/**
 * Build a CSV document.
 *   headers: string[]              — the header row, in column order
 *   rows:    Array<Array<any>>     — each row already projected to cells, same
 *                                    length + order as headers
 * CRLF line endings + a trailing newline (Excel-friendly). An empty `rows` yields
 * the header row alone — a valid, non-crashing export.
 */
function toCsv(headers, rows) {
  const lines = [csvRow(headers)];
  for (const r of rows) lines.push(csvRow(r));
  return lines.join('\r\n') + '\r\n';
}

// epoch ms -> ISO 8601 (UTC), or '' when absent/invalid. A model reads a date far
// better than a raw millisecond count.
function iso(ms) {
  if (ms == null || ms === '') return '';
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

// array -> "a|b|c" (pipe, so it never clashes with the CSV comma); '' when empty.
function pipe(arr) {
  if (!Array.isArray(arr) || !arr.length) return '';
  return arr.join('|');
}

// boolean -> 'true'/'false'; null/undefined -> '' — an unknown is not a "no".
function bool(v) { return v == null ? '' : (v ? 'true' : 'false'); }

// JSON string for a cell whose value has no fixed shape (a config diff before/after).
function json(v) { return v == null ? '' : JSON.stringify(v); }

// YYYY-MM-DD stamp for a filename, or 'all' when the bound is open.
function stamp(ms) { return iso(ms).slice(0, 10) || 'all'; }

// ---- IST (Asia/Kolkata) rendering for director-facing exports --------------------------------
// The director reconciles our export against SuperProcure's, which is keyed to IST calendar days
// (SP shows "23-Jul 2026"). A UTC stamp is off by 5h30 and, for anything after 18:30 IST, lands on
// the WRONG calendar day — so a load closed at 23:00 IST on the 23rd would file/read as the 24th
// under the old iso().slice(0,10) path. These render the IST wall-clock instead. Intl with a fixed
// timeZone is the same mechanism priceRequests.js already uses for the capture-link day slug.
const IST_YMD = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const IST_HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const IST_HMS = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

// epoch ms -> "YYYY-MM-DD" in IST, or '' when absent/invalid.
function istDate(ms) {
  if (ms == null || ms === '') return '';
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? '' : IST_YMD.format(d); // en-CA yields YYYY-MM-DD
}

// epoch ms -> "HH:MM" (24h) in IST, or '' when absent/invalid.
function istTime(ms) {
  if (ms == null || ms === '') return '';
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  // en-GB 24h can emit "24:00" at midnight on some ICU builds; normalize to "00:00".
  return IST_HM.format(d).replace(/^24:/, '00:');
}

// epoch ms -> "YYYY-MM-DD HH:MM" IST, or '' when absent/invalid.
function istDateTime(ms) {
  const d = istDate(ms);
  return d ? `${d} ${istTime(ms)}` : '';
}

// epoch ms -> "YYYY-MM-DD HH:MM:SS" IST, or '' when absent/invalid. For bid timing, where the
// seconds are the fact being read; every other column keeps istDateTime.
function istDateTimeSecs(ms) {
  const d = istDate(ms);
  return d ? `${d} ${IST_HMS.format(new Date(Number(ms))).replace(/^24:/, '00:')}` : '';
}

// IST YYYY-MM-DD stamp for a filename, or 'all' when the bound is open. The filename must carry
// the IST day so a file the director saves self-documents to the same calendar day SP reports.
function istStamp(ms) { return istDate(ms) || 'all'; }

module.exports = { toCsv, csvField, csvRow, iso, pipe, bool, json, stamp, istDate, istTime, istDateTime, istDateTimeSecs, istStamp };
