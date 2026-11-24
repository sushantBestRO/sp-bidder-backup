'use strict';

/**
 * Minimal, zero-dependency .xlsx (OOXML SpreadsheetML) writer for the export endpoints.
 *
 * WHY hand-write it instead of adding `exceljs`. The director works in Excel and asked for a
 * true .xlsx (AutoFilter on, frozen header, typed number cells) rather than a CSV Excel merely
 * opens. But this is a live-money box where dependency minimisation is a standing principle:
 * the CSV export (src/web/csv.js) was deliberately built with no new deps and no `fs`, and the
 * whole backend carries only five runtime deps. Adding a spreadsheet library to that surface is
 * precedent-setting (the data-export scope doc, section 9, flags it explicitly). So this emits
 * exactly the OOXML parts we need and nothing else, using only Node built-ins (`zlib` for
 * DEFLATE; a hand-rolled ZIP container + CRC-32). It reuses the same `{headers, rows}` projection
 * the CSV path uses, so both formats are fed by one builder.
 *
 * SECURITY note (CSV-injection / CWE-1236): unlike CSV, an .xlsx string cell is a literal, never
 * a formula — a value like `=IMPORTXML(...)` written as an inline string is the TEXT "=IMPORTXML(...)",
 * not an executed formula (formulas live in a separate <f> element we never emit). So the
 * apostrophe text-forcing the CSV path needs is unnecessary here; string cells are inert by
 * construction. Numeric cells only ever hold values the caller flagged numeric AND that parse to
 * a finite Number, so a crafted string can never land in a numeric cell.
 *
 * Pure in-memory: returns a Buffer, touches no filesystem (the `fs`-free rule the store seam
 * enforces holds here too). Deterministic: no timestamps in the ZIP entries, so the same input
 * yields byte-identical output (test-friendly).
 */

const zlib = require('zlib');

// ---- CRC-32 (ZIP entries require it; zlib exposes no public crc32) ----------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// ---- XML escaping ----------------------------------------------------------------------------
// Escape the five XML metacharacters for text nodes and attribute values. inlineStr <t> content
// and the sheet name both flow through here.
function xmlEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 0-based column index -> Excel column letters (0 -> A, 25 -> Z, 26 -> AA).
function colLetter(n) {
  let s = '';
  let i = n;
  do {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
}

// Is this value a finite number we can write as a typed numeric cell? Accepts a Number or a
// numeric string ("90000.00" — SuperProcure ships some numbers as strings). Blank/null/non-numeric
// -> false, so it renders as an (empty) cell rather than a lying 0.
function asNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the worksheet XML. `numericCols` is a Set of 0-based column indices that should be written
 * as typed numbers when their value parses to a finite Number (so Excel sorts/sums them). The
 * header row is bold (style s="1"), frozen (pane split below row 1), and AutoFilter is enabled
 * across the used range so the director filters every column in his own tool.
 */
function sheetXml(headers, rows, numericCols) {
  const nRows = rows.length + 1; // + header
  const lastCol = colLetter(Math.max(0, headers.length - 1));
  const ref = `A1:${lastCol}${nRows}`;

  const cell = (colIdx, rowNum, value, { header = false } = {}) => {
    const r = `${colLetter(colIdx)}${rowNum}`;
    if (!header && numericCols && numericCols.has(colIdx)) {
      const num = asNumber(value);
      if (num != null) return `<c r="${r}"><v>${num}</v></c>`;
    }
    if (value == null || value === '') return `<c r="${r}"/>`;
    const s = header ? ' s="1"' : '';
    // inline string: a literal, never evaluated as a formula (see module header).
    return `<c r="${r}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(value)}</t></is></c>`;
  };

  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  out.push(`<dimension ref="${ref}"/>`);
  // Freeze the header row so it stays visible while scrolling.
  out.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
  out.push('<sheetFormatPr defaultRowHeight="15"/>');
  out.push('<sheetData>');
  // header row (bold)
  out.push('<row r="1">');
  for (let c = 0; c < headers.length; c++) out.push(cell(c, 1, headers[c], { header: true }));
  out.push('</row>');
  // body
  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    out.push(`<row r="${rowNum}">`);
    const row = rows[i];
    for (let c = 0; c < headers.length; c++) out.push(cell(c, rowNum, row[c]));
    out.push('</row>');
  }
  out.push('</sheetData>');
  // AutoFilter must come AFTER sheetData per the schema's element order.
  out.push(`<autoFilter ref="${ref}"/>`);
  out.push('</worksheet>');
  return out.join('');
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>';

const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

const WORKBOOK_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

// Excel forbids [ ] : * ? / \ in a sheet name and caps it at 31 chars.
function safeSheetName(name) {
  const cleaned = String(name || 'Sheet1').replace(/[\[\]:*?/\\]/g, ' ').trim() || 'Sheet1';
  return cleaned.slice(0, 31);
}

function workbookXml(sheetName) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${xmlEsc(safeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>'
  );
}

/**
 * Assemble the full set of OOXML parts as {partName -> xmlString}. Kept as a separate step from
 * zipping so a test can assert on the parts directly (AutoFilter present, numeric cell types,
 * header text) without needing a ZIP reader.
 */
function buildParts({ sheetName, headers, rows, numericColumns }) {
  const numericCols = new Set(numericColumns || []);
  return {
    '[Content_Types].xml': CONTENT_TYPES_XML,
    '_rels/.rels': ROOT_RELS_XML,
    'xl/workbook.xml': workbookXml(sheetName),
    'xl/_rels/workbook.xml.rels': WORKBOOK_RELS_XML,
    'xl/styles.xml': STYLES_XML,
    'xl/worksheets/sheet1.xml': sheetXml(headers, rows, numericCols),
  };
}

// ---- ZIP container (store the XML parts, DEFLATE-compressed) ----------------------------------
// A single deterministic ZIP: local file headers + data, then the central directory, then the
// end-of-central-directory record. No timestamps (dosTime/dosDate = 0) so output is reproducible.
function zipParts(parts) {
  const names = Object.keys(parts);
  const fileChunks = [];
  const central = [];
  let offset = 0;

  for (const name of names) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(parts[name], 'utf8');
    const crc = crc32(data);
    const compressed = zlib.deflateRawSync(data);
    const uSize = data.length;
    const cSize = compressed.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method = deflate
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(cSize, 18);
    local.writeUInt32LE(uSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    fileChunks.push(local, nameBuf, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central dir signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(8, 10); // method
    cd.writeUInt16LE(0, 12); // mod time
    cd.writeUInt16LE(0, 14); // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(cSize, 20);
    cd.writeUInt32LE(uSize, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const filesBuf = Buffer.concat(fileChunks);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(names.length, 8); // entries this disk
  eocd.writeUInt16LE(names.length, 10); // total entries
  eocd.writeUInt32LE(centralBuf.length, 12); // central dir size
  eocd.writeUInt32LE(filesBuf.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([filesBuf, centralBuf, eocd]);
}

/**
 * Build a complete .xlsx workbook as a Buffer.
 *   opts.sheetName      display name of the single worksheet
 *   opts.headers        string[] header row
 *   opts.rows           Array<Array<any>> body cells (same length/order as headers)
 *   opts.numericColumns number[] of 0-based column indices to type as numbers when parseable
 */
function toXlsx(opts) {
  return zipParts(buildParts(opts));
}

// The OOXML MIME type for the Content-Type response header.
const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

module.exports = { toXlsx, buildParts, zipParts, sheetXml, crc32, colLetter, XLSX_CONTENT_TYPE };
