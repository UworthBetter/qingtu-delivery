/* 极简 xlsx 读写(零依赖):
   read(buf)  → { sheets:[{name, rows:[[字符串...]]}] },合并单元格的值向下 / 向右填充,Excel 日期序列号转为 YYYY-MM-DD
   write(sheet) → Buffer(单个工作表,支持合并单元格、列宽、少量样式) */
'use strict';
const zlib = require('zlib');

/* ---------- ZIP ---------- */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件(ZIP 结构损坏)');
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString('utf8');
    const lnl = buf.readUInt16LE(off + 26), lel = buf.readUInt16LE(off + 28), start = off + 30 + lnl + lel;
    const raw = buf.slice(start, start + csize);
    files[name] = () => method === 0 ? raw : zlib.inflateRawSync(raw);
    p += 46 + nl + el + cl;
  }
  return files;
}
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function zip(entries) {
  const locals = [], centrals = []; let off = 0;
  for (const [name, data0] of entries) {
    const data = Buffer.isBuffer(data0) ? data0 : Buffer.from(data0, 'utf8'), nm = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, comp); centrals.push(ch, nm);
    off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat(locals.concat([cd, end]));
}

/* ---------- XML 工具 ---------- */
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&');
const xesc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = (tag, name) => { const m = tag.match(new RegExp('\\s' + name + '="([^"]*)"')); return m ? unesc(m[1]) : null; };
const texts = xml => { const out = []; xml.replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (m, t) => out.push(unesc(t))); return out.join(''); };
function colIdx(ref) { const m = ref.match(/^([A-Z]+)/); let n = 0; for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }
function cellRC(ref) { const m = ref.match(/^([A-Z]+)(\d+)$/); return [+m[2] - 1, colIdx(m[1])]; }
function colName(n) { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

/* Excel 日期序列号(1900 体系)→ YYYY-MM-DD */
function serialDate(v) { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000); return d.toISOString().slice(0, 10); }

/* ---------- 读取 ---------- */
function read(buf) {
  const f = unzip(buf), get = n => f[n] ? f[n]().toString('utf8') : null;
  const wb = get('xl/workbook.xml'); if (!wb) throw new Error('不是有效的 xlsx 文件(缺少 workbook)');
  const rels = get('xl/_rels/workbook.xml.rels') || '', relMap = {};
  rels.replace(/<Relationship\b[^>]*>/g, t => { relMap[attr(t, 'Id')] = attr(t, 'Target'); });
  const ss = []; const sst = get('xl/sharedStrings.xml');
  if (sst) sst.replace(/<si>([\s\S]*?)<\/si>/g, (m, x) => ss.push(texts(x)));
  /* 日期样式:numFmtId 14–22、45–47 或自定义格式含 y/m/d */
  const dateStyles = new Set(); const st = get('xl/styles.xml');
  if (st) {
    const custom = {}; st.replace(/<numFmt\b[^>]*>/g, t => { custom[attr(t, 'numFmtId')] = attr(t, 'formatCode') || ''; });
    const xfs = (st.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/) || [])[1] || '';
    let i = 0; xfs.replace(/<xf\b[^>]*\/?>/g, t => { const id = +attr(t, 'numFmtId'); const code = custom[id] || '';
      if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (/[ymd]/i.test(code.replace(/\[[^\]]*\]|"[^"]*"/g, '')) && !/^[#0.,%]+$/.test(code))) dateStyles.add(i); i++; });
  }
  const sheets = [];
  wb.replace(/<sheet\b[^>]*>/g, t => {
    const name = attr(t, 'name'), rid = attr(t, 'r:id'); let target = relMap[rid] || '';
    target = target.replace(/^\/?xl\//, '').replace(/^\//, '');
    const xml = get('xl/' + target); if (!xml) return;
    const rows = [];
    xml.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (m, a, inner) => {
      const ref = attr(' ' + a, 'r'); if (!ref) return;
      const [r, c] = cellRC(ref), type = attr(' ' + a, 't'), s = +(attr(' ' + a, 's') || 0);
      let v = '';
      if (inner) {
        const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
        if (type === 's') v = vm ? ss[+vm[1]] || '' : '';
        else if (type === 'inlineStr') v = texts(inner);
        else if (type === 'b') v = vm && vm[1] === '1' ? 'TRUE' : 'FALSE';
        else if (vm) { v = unesc(vm[1]); if ((type == null || type === 'n') && dateStyles.has(s) && !isNaN(+v) && +v > 20000 && +v < 80000) v = serialDate(+v); else if (!isNaN(+v) && /\.\d{6,}/.test(v)) v = String(Math.round(+v * 1e6) / 1e6); }
      }
      (rows[r] = rows[r] || [])[c] = v;
    });
    /* 合并单元格:把左上角的值填满整个区域 */
    xml.replace(/<mergeCell\b[^>]*ref="([A-Z]+\d+):([A-Z]+\d+)"/g, (m, a, b) => {
      const [r1, c1] = cellRC(a), [r2, c2] = cellRC(b), v = (rows[r1] || [])[c1];
      if (v == null || v === '') return;
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) { (rows[r] = rows[r] || [])[c] = v; }
    });
    const out = []; for (let r = 0; r < rows.length; r++) { const row = rows[r] || []; const a = []; for (let c = 0; c < row.length; c++) a.push(row[c] == null ? '' : String(row[c])); out.push(a); }
    sheets.push({ name, rows: out });
  });
  return { sheets };
}

/* ---------- 写入 ----------
   sheet: { name, rows:[[值|{v,s}]], merges:['A1:H1'], cols:[宽度], heights:{行号:高度}, freeze:{row,col} }
   样式编号见 STYLES */
const STYLES = { normal: 0, cell: 1, title: 2, head: 3, done: 4, active: 5, pending: 6, late: 7, left: 8, base: 9, weekend: 10 };
function stylesXml() {
  const fills = ['none', 'gray125', 'E8EAEE', '3BAA6A', '2B5CD9', 'C9CFDA', 'D9534F', 'F6E7C1', 'F4F5F8'];
  const fx = fills.map((f, i) => i < 2 ? '<fill><patternFill patternType="' + f + '"/></fill>' : '<fill><patternFill patternType="solid"><fgColor rgb="FF' + f + '"/><bgColor indexed="64"/></patternFill></fill>').join('');
  const b = '<border><left style="thin"><color rgb="FFB8BEC8"/></left><right style="thin"><color rgb="FFB8BEC8"/></right><top style="thin"><color rgb="FFB8BEC8"/></top><bottom style="thin"><color rgb="FFB8BEC8"/></bottom><diagonal/></border>';
  const xf = (font, fill, border, h) => '<xf numFmtId="0" fontId="' + font + '" fillId="' + fill + '" borderId="' + border + '" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="' + h + '" vertical="center" wrapText="1"/></xf>';
  const xfs = [xf(0, 0, 0, 'general'), xf(0, 0, 1, 'center'), xf(1, 0, 0, 'center'), xf(2, 2, 1, 'center'), xf(0, 3, 1, 'center'), xf(0, 4, 1, 'center'), xf(0, 5, 1, 'center'), xf(0, 6, 1, 'center'), xf(0, 0, 1, 'left'), xf(0, 7, 1, 'center'), xf(0, 8, 1, 'center')];
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="3"><font><sz val="10"/><name val="微软雅黑"/></font><font><b/><sz val="16"/><name val="微软雅黑"/></font><font><b/><sz val="10"/><name val="微软雅黑"/></font></fonts>'
    + '<fills count="' + fills.length + '">' + fx + '</fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' + b + '</borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="' + xfs.length + '">' + xfs.join('') + '</cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
}
function write(sheet) {
  const rowsXml = sheet.rows.map((row, r) => {
    const ht = sheet.heights && sheet.heights[r] ? ' ht="' + sheet.heights[r] + '" customHeight="1"' : '';
    return '<row r="' + (r + 1) + '"' + ht + '>' + row.map((c, ci) => {
      if (c == null) return '';
      const cell = typeof c === 'object' ? c : { v: c }, ref = colName(ci) + (r + 1), s = cell.s ? ' s="' + cell.s + '"' : '';
      if (cell.v == null || cell.v === '') return '<c r="' + ref + '"' + s + '/>';
      if (typeof cell.v === 'number') return '<c r="' + ref + '"' + s + '><v>' + cell.v + '</v></c>';
      return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + xesc(cell.v) + '</t></is></c>';
    }).join('') + '</row>';
  }).join('');
  const cols = sheet.cols ? '<cols>' + sheet.cols.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>' : '';
  const merges = sheet.merges && sheet.merges.length ? '<mergeCells count="' + sheet.merges.length + '">' + sheet.merges.map(m => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>' : '';
  const fz = sheet.freeze ? '<sheetViews><sheetView workbookViewId="0"><pane xSplit="' + sheet.freeze.col + '" ySplit="' + sheet.freeze.row + '" topLeftCell="' + colName(sheet.freeze.col) + (sheet.freeze.row + 1) + '" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>' : '';
  const ws = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + fz + '<sheetFormatPr defaultRowHeight="18"/>' + cols + '<sheetData>' + rowsXml + '</sheetData>' + merges
    + '<pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup orientation="landscape" paperSize="9" fitToHeight="0"/></worksheet>';
  const name = xesc((sheet.name || 'Sheet1').slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + name + '" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', stylesXml()],
    ['xl/worksheets/sheet1.xml', ws]
  ]);
}

/* ---------- CSV ---------- */
function readCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = [], cur = '', q = false;
  const sep = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function writeCsv(rows) { return '﻿' + rows.map(r => r.map(v => { v = v == null ? '' : String(typeof v === 'object' ? v.v : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\r\n'); }

module.exports = { read, write, readCsv, writeCsv, STYLES, colName, unzip, zip, crc32 };
