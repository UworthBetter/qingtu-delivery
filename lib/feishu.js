/* 飞书:群自定义机器人推送 + 开放平台(tenant_access_token、电子表格读写)
   未配置时为演示模式:消息只进入 outbox,在系统「飞书消息预览」里查看。 */
'use strict';
const crypto = require('crypto');

const OWNER_WARN = '表格归应用所有,请配置 FEISHU_OWNER_* 或使用已有表格链接';
const MAX_ROWS = 5000, MAX_COLS = 100, BITABLE_BATCH = 500;

module.exports = function (ctx) {
  const env = ctx.env;
  const domain = () => (env.FEISHU_DOMAIN || 'https://open.feishu.cn').replace(/\/+$/, '');

  /* 签名:以「timestamp\n密钥」为 HmacSHA256 的 key,对空串签名后 Base64 */
  function sign(ts, secret) {
    return crypto.createHmac('sha256', ts + '\n' + secret).update('').digest('base64');
  }

  async function postBot(card) {
    const body = { msg_type: 'interactive', card };
    if (env.FEISHU_SECRET) { const ts = String(Math.floor(Date.now() / 1000)); body.timestamp = ts; body.sign = sign(ts, env.FEISHU_SECRET); }
    const r = await fetch(env.FEISHU_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || (j.code != null && j.code !== 0) || (j.StatusCode != null && j.StatusCode !== 0)) throw new Error('飞书返回错误:' + (j.msg || j.StatusMessage || r.status));
    return j;
  }

  /* 统一出口:记入 outbox(预览面板),已配置机器人则真实推送 */
  async function send(kind, card, meta) {
    const msg = { id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ts: Date.now(), kind, card, meta: meta || {}, status: 'demo', error: null };
    if (env.FEISHU_WEBHOOK) {
      try { await postBot(card); msg.status = 'sent'; } catch (e) { msg.status = 'failed'; msg.error = e.message; console.error('[feishu]', e.message); }
    }
    const ob = ctx.store.data.outbox; ob.unshift(msg); if (ob.length > 200) ob.length = 200;
    ctx.store.save();
    ctx.broadcast('outbox', { msg });
    return msg;
  }

  /* 卡片(飞书消息卡片 JSON):标题 + lark_md 正文 + 按钮 + 备注 */
  function card(title, color, blocks, buttons, note) {
    const el = [];
    blocks.forEach((b, i) => { if (b === '---') el.push({ tag: 'hr' }); else el.push({ tag: 'div', text: { tag: 'lark_md', content: b } }); });
    if (buttons && buttons.length) el.push({ tag: 'action', actions: buttons.map((b, i) => ({ tag: 'button', text: { tag: 'plain_text', content: b.text }, type: i ? 'default' : 'primary', url: b.url })) });
    if (note) el.push({ tag: 'note', elements: [{ tag: 'plain_text', content: note }] });
    return { config: { wide_screen_mode: true }, header: { template: color || 'blue', title: { tag: 'plain_text', content: title } }, elements: el };
  }

  /* ---------- 开放平台 ---------- */
  const bad = (msg, status) => Object.assign(new Error(msg), { status: status || 400 });
  const tz = () => env.FEISHU_TZ || 'Asia/Shanghai';
  let tok = null;
  async function tenantToken() {
    if (!(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET)) throw bad('未配置飞书开放平台应用(FEISHU_APP_ID / FEISHU_APP_SECRET)');
    if (tok && tok.exp > Date.now() + 60000) return tok.v;
    const r = await fetch(domain() + '/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }), signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (j.code !== 0) throw bad('获取飞书访问凭证失败:' + j.msg, 502);
    tok = { v: j.tenant_access_token, exp: Date.now() + (j.expire || 7200) * 1000 };
    return tok.v;
  }
  async function api(method, p, body) {
    const t = await tenantToken();
    const r = await fetch(domain() + p, { method, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json; charset=utf-8' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({ code: -1, msg: 'HTTP ' + r.status }));
    if (j.code !== 0) throw Object.assign(new Error('飞书接口错误:' + (j.msg || j.code) + '(code ' + j.code + ')'), { status: 502, feishuCode: j.code });
    return j.data || {};
  }
  /* 分页读取(items / has_more / page_token) */
  async function pageAll(p, size) {
    const out = []; let pt = '';
    for (let i = 0; i < 500; i++) {
      const d = await api('GET', p + (p.includes('?') ? '&' : '?') + 'page_size=' + size + (pt ? '&page_token=' + encodeURIComponent(pt) : ''));
      out.push(...(d.items || []));
      if (!d.has_more || !d.page_token) break;
      pt = d.page_token;
    }
    return out;
  }
  async function cleanup(fn, what) {
    try { await fn(); } catch (e) { console.error('[feishu] ' + what + '失败(忽略):', e.message); }
  }
  const deleteFile = (token, type) => api('DELETE', '/open-apis/drive/v1/files/' + token + '?type=' + type);

  /* 识别链接:电子表格 /sheets/、多维表格 /base/、知识库 /wiki/(换取实际文档) */
  async function resolveDoc(url) {
    let u; try { u = new URL(String(url || '').trim()); } catch (e) { throw bad('链接格式不正确,请粘贴完整的飞书链接(https://…)'); }
    const q = k => u.searchParams.get(k);
    let m;
    if ((m = u.pathname.match(/\/sheets\/([A-Za-z0-9]+)/))) return { kind: 'sheet', token: m[1], sheetId: q('sheet'), url: u.href };
    if ((m = u.pathname.match(/\/base\/([A-Za-z0-9]+)/))) return { kind: 'bitable', token: m[1], tableId: q('table'), viewId: q('view'), url: u.href };
    if ((m = u.pathname.match(/\/wiki\/([A-Za-z0-9]+)/))) {
      const node = (await api('GET', '/open-apis/wiki/v2/spaces/get_node?token=' + m[1])).node || {};
      if (node.obj_type === 'sheet') return { kind: 'sheet', token: node.obj_token, sheetId: q('sheet'), url: u.href, wiki: true };
      if (node.obj_type === 'bitable') return { kind: 'bitable', token: node.obj_token, tableId: q('table'), viewId: q('view'), url: u.href, wiki: true };
      throw bad('该知识库页面不是电子表格或多维表格');
    }
    throw bad('无法识别的飞书链接,请粘贴电子表格(/sheets/)、多维表格(/base/)或知识库(/wiki/)链接');
  }

  /* ---------- 电子表格 ---------- */
  const sheetsOf = async token => ((await api('GET', '/open-apis/sheets/v3/spreadsheets/' + token + '/sheets/query')).sheets || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
  async function readSheet(url) {
    const d = typeof url === 'string' ? await resolveDoc(url) : url;
    if (d.kind !== 'sheet') return readBitable(d);
    let sheetId = d.sheetId;
    if (!sheetId) { const sh = await sheetsOf(d.token); sheetId = sh[0] && sh[0].sheet_id; }
    if (!sheetId) throw bad('该电子表格中没有工作表');
    const v = await api('GET', '/open-apis/sheets/v2/spreadsheets/' + d.token + '/values/' + encodeURIComponent(sheetId + '!A1:AZ300') + '?valueRenderOption=FormattedValue&dateTimeRenderOption=FormattedString');
    const rows = (v.valueRange && v.valueRange.values) || [];
    return rows.map(r => (r || []).map(x => x == null ? '' : (typeof x === 'object' ? (Array.isArray(x) ? x.map(s => (s && s.text) || '').join('') : (x.text || x.link || JSON.stringify(x))) : String(x))));
  }
  /* 工作表行列不够时先扩展(每次最多 5000) */
  async function ensureGrid(token, sheet, rows, cols) {
    const g = sheet.grid_properties; if (!g) return;
    for (const [dim, have, need] of [['ROWS', g.row_count, rows], ['COLUMNS', g.column_count, cols]]) {
      let lack = need - (have || 0);
      while (lack > 0) { const n = Math.min(lack, 5000); await api('POST', '/open-apis/sheets/v2/spreadsheets/' + token + '/dimension_range', { dimension: { sheetId: sheet.sheet_id, majorDimension: dim, length: n } }); lack -= n; }
    }
  }
  /* 写入:规范成矩形 → 按单次上限分批 PUT */
  async function writeValues(token, sheet, rows) {
    const values = normalizeValues(rows);
    await ensureGrid(token, sheet, values.length, values[0].length);
    const parts = chunkValues(sheet.sheet_id, values);
    for (const part of parts) await api('PUT', '/open-apis/sheets/v2/spreadsheets/' + token + '/values', { valueRange: part });
    return { rows: values.length, cols: values[0].length, batches: parts.length };
  }
  /* 导出到电子表格:有链接则在其中新建工作表,否则新建电子表格(失败时清理) */
  async function exportSheet(o) {
    const d = o.doc;
    if (d) {
      const existing = await sheetsOf(d.token);
      const title = uniqueName(sheetName(o.sheetTitle || o.title), existing.map(s => s.title), 100);
      const r = await api('POST', '/open-apis/sheets/v2/spreadsheets/' + d.token + '/sheets_batch_update', { requests: [{ addSheet: { properties: { title, index: 0 } } }] });
      const p = r.replies && r.replies[0] && r.replies[0].addSheet && r.replies[0].addSheet.properties;
      if (!p || !p.sheetId) throw bad('新建工作表失败:飞书未返回工作表 id', 502);
      try { await writeValues(d.token, { sheet_id: p.sheetId }, o.rows); } catch (e) {
        await cleanup(() => api('POST', '/open-apis/sheets/v2/spreadsheets/' + d.token + '/sheets_batch_update', { requests: [{ deleteSheet: { sheetId: p.sheetId } }] }), '删除写入失败的工作表');
        throw e;
      }
      return { kind: 'sheet', url: withParam(d.url, 'sheet', p.sheetId), token: d.token, sheetTitle: title, owner: 'existing' };
    }
    const s = (await api('POST', '/open-apis/sheets/v3/spreadsheets', { title: String(o.title).slice(0, 255) })).spreadsheet;
    const token = s.spreadsheet_token;
    try {
      const sheet = (await sheetsOf(token))[0];
      if (!sheet) throw bad('新建的电子表格中没有工作表', 502);
      await writeValues(token, sheet, o.rows);
    } catch (e) { await cleanup(() => deleteFile(token, 'sheet'), '删除写入失败的空表格'); throw e; }
    return Object.assign({ kind: 'sheet', url: s.url, token }, await share(token, 'sheet'));
  }
  /* 兼容旧调用:新建电子表格并写入二维数组 */
  const writeSheet = (title, rows) => exportSheet({ title, rows });

  /* ---------- 协作者 / 所有权 ---------- */
  function ownerCfg() {
    if (env.FEISHU_OWNER_OPEN_ID) return { member_type: 'openid', member_id: env.FEISHU_OWNER_OPEN_ID.trim() };
    if (env.FEISHU_OWNER_EMAIL) return { member_type: 'email', member_id: env.FEISHU_OWNER_EMAIL.trim() };
    return null;
  }
  async function share(token, type) {
    const o = ownerCfg();
    if (!o) return { owner: 'app', warning: OWNER_WARN };
    try { await api('POST', '/open-apis/drive/v1/permissions/' + token + '/members?type=' + type + '&need_notification=false', Object.assign({ perm: 'edit' }, o)); }
    catch (e) { console.error('[feishu] 添加协作者失败:', e.message); return { owner: 'app', warning: '已创建,但添加协作者失败(' + e.message + '),' + OWNER_WARN }; }
    try { await api('POST', '/open-apis/drive/v1/permissions/' + token + '/members/transfer_owner?type=' + type + '&need_notification=false&remove_old_owner=false&old_owner_perm=full_access', o); return { owner: 'transferred' }; }
    catch (e) { console.error('[feishu] 转移所有权失败,保留协作者权限:', e.message); return { owner: 'collaborator', note: '已把你加为可编辑协作者(所有权转移未成功,表格仍归应用所有)' }; }
  }

  /* ---------- 多维表格(bitable v1) ---------- */
  async function readBitable(url) {
    const d = typeof url === 'string' ? await resolveDoc(url) : url;
    const base = '/open-apis/bitable/v1/apps/' + d.token + '/tables';
    let table = d.tableId;
    if (!table) { const ts = await pageAll(base, 100); if (!ts.length) throw bad('该多维表格中没有数据表'); table = ts[0].table_id; }
    const view = d.viewId ? '?view_id=' + encodeURIComponent(d.viewId) : '';
    const fields = await pageAll(base + '/' + table + '/fields' + view, 100);
    const records = await pageAll(base + '/' + table + '/records' + view, 500);
    return bitableRows(fields, records, tz());
  }
  async function exportBitable(o) {
    const d = o.doc;
    let app, url, created = false, tableId = null;
    if (d) { app = d.token; url = d.url; }
    else { const r = (await api('POST', '/open-apis/bitable/v1/apps', { name: String(o.title).slice(0, 255) })).app; app = r.app_token; url = r.url; created = true; }
    const base = '/open-apis/bitable/v1/apps/' + app + '/tables';
    try {
      const old = await pageAll(base, 100);
      const name = uniqueName(o.tableName || o.title, old.map(t => t.name), 100);
      const t = await api('POST', base, { table: { name, default_view_name: '计划表', fields: o.fields.map(f => Object.assign({ field_name: f.name, type: f.type }, f.property ? { property: f.property } : {})) } });
      tableId = t.table_id;
      if (!tableId) throw bad('新建数据表失败:飞书未返回数据表 id', 502);
      const recs = toBitableRecords(o.fields, o.records, tz());
      for (let i = 0; i < recs.length; i += BITABLE_BATCH) await api('POST', base + '/' + tableId + '/records/batch_create', { records: recs.slice(i, i + BITABLE_BATCH) });
      /* 新建的多维表格自带一张空数据表,删掉 */
      if (created) for (const x of old) await cleanup(() => api('DELETE', base + '/' + x.table_id), '删除默认数据表');
      if (!url) url = domain().replace('open.', '') + '/base/' + app;
      const out = { kind: 'bitable', url: withParam(url, 'table', tableId), token: app, tableName: name };
      return Object.assign(out, created ? await share(app, 'bitable') : { owner: 'existing' });
    } catch (e) {
      if (created) await cleanup(() => deleteFile(app, 'bitable'), '删除写入失败的多维表格');
      else if (tableId) await cleanup(() => api('DELETE', base + '/' + tableId), '删除写入失败的数据表');
      throw e;
    }
  }

  /* 统一入口:导入读取 / 导出写入 */
  /* 文档标题:多维表格取 app 名称,电子表格取表格标题;读不到返回空串 */
  async function docTitle(url) {
    try {
      const d = await resolveDoc(url);
      if (d.kind === 'bitable') return String(((await api('GET', '/open-apis/bitable/v1/apps/' + d.token)).app || {}).name || '').trim();
      return String(((await api('GET', '/open-apis/sheets/v3/spreadsheets/' + d.token)).spreadsheet || {}).title || '').trim();
    } catch (e) { return ''; }
  }
  async function readDoc(url) { const d = await resolveDoc(url); return d.kind === 'bitable' ? readBitable(d) : readSheet(d); }
  async function exportDoc(o) {
    const doc = o.url ? await resolveDoc(o.url) : null;
    const kind = doc ? doc.kind : (o.target === 'bitable' ? 'bitable' : 'sheet');
    return kind === 'bitable' ? exportBitable(Object.assign({}, o.bitable, { title: o.title, tableName: o.sheetTitle, doc })) : exportSheet({ title: o.title, sheetTitle: o.sheetTitle, rows: o.rows, doc });
  }

  ctx.feishu = { send, card, sign, tenantToken, api, resolveDoc, readDoc, docTitle, readSheet, readBitable, writeSheet, exportSheet, exportBitable, exportDoc, share,
    ownerReady: () => !!ownerCfg(), appReady: () => !!(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET), botReady: () => !!env.FEISHU_WEBHOOK };
  return ctx.feishu;
};

/* ======================= 纯函数(无网络,便于单元测试) ======================= */
/* 0 → A,25 → Z,26 → AA */
function colName(n) { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
/* 单元格:空洞 / undefined / null / NaN → "";{v} 取 v;数字保留;其余转字符串 */
function cellValue(c) {
  if (c != null && typeof c === 'object' && !Array.isArray(c)) c = 'v' in c ? c.v : c.text;
  if (c == null) return '';
  if (typeof c === 'number') return Number.isFinite(c) ? c : '';
  if (typeof c === 'boolean') return c ? '是' : '';
  if (Array.isArray(c)) return c.map(cellValue).join('');
  return String(c);
}
/* 规范成严格矩形的二维数组:每行列数相同,去掉尾部空行 / 空列;至少 1×1 */
function normalizeValues(rows) {
  const out = Array.from(Array.isArray(rows) ? rows : [], r => Array.isArray(r) ? Array.from(r, x => cellValue(x)) : (r == null ? [] : [cellValue(r)]));
  while (out.length && out[out.length - 1].every(c => c === '')) out.pop();
  if (!out.length) out.push(['']);
  let cols = 1;
  out.forEach(r => { let n = r.length; while (n && r[n - 1] === '') n--; if (n > cols) cols = n; });
  return out.map(r => { const a = r.slice(0, cols); while (a.length < cols) a.push(''); return a; });
}
/* range:「sheetId!A1:{末列}{末行}」,r0 / c0 为 0 起始的左上角 */
function rangeFor(sheetId, r0, c0, nRows, nCols) { return sheetId + '!' + colName(c0) + (r0 + 1) + ':' + colName(c0 + nCols - 1) + (r0 + nRows); }
/* 按飞书单次写入上限(5000 行 × 100 列)切块,每块 range 与 values 行列数严格一致 */
function chunkValues(sheetId, values, maxRows, maxCols) {
  maxRows = maxRows || MAX_ROWS; maxCols = maxCols || MAX_COLS;
  const out = [], R = values.length, C = values[0].length;
  for (let r = 0; r < R; r += maxRows) for (let c = 0; c < C; c += maxCols) {
    const part = values.slice(r, r + maxRows).map(row => row.slice(c, c + maxCols));
    out.push({ range: rangeFor(sheetId, r, c, part.length, part[0].length), values: part });
  }
  return out;
}
/* 工作表 / 数据表名:去掉飞书不允许的字符,重名时加 (2)(3)… */
function sheetName(s) { return String(s || '计划表').replace(/[\/\\?*\[\]:]/g, '-').trim().slice(0, 100) || '计划表'; }
function uniqueName(base, existing, max) {
  base = String(base || '计划表').slice(0, max || 100);
  const has = new Set(existing || []);
  if (!has.has(base)) return base;
  for (let i = 2; ; i++) { const sfx = '(' + i + ')', n = base.slice(0, (max || 100) - sfx.length) + sfx; if (!has.has(n)) return n; }
}
function withParam(url, k, v) { try { const u = new URL(url); u.searchParams.set(k, v); return u.href; } catch (e) { return url; } }

/* 日期:多维表格存毫秒时间戳,按时区(默认 Asia/Shanghai)换算成 YYYY-MM-DD */
function safeTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return 'Asia/Shanghai'; } }
function fmtDate(ms, tz) {
  const d = new Date(+ms); if (isNaN(d)) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: safeTz(tz), year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function tzOffset(ts, tz) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: safeTz(tz), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ts)).forEach(x => { p[x.type] = x.value; });
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ts;
}
function dateMs(s, tz) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(s || '')); if (!m) return null;
  const g = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return g - tzOffset(g, tz);
}
/* 多维表格字段值 → 纯文本。type:1 文本 2 数字 3 单选 4 多选 5 日期 7 复选框 11 人员 13 电话 15 超链接 17 附件
   18/21 关联 19 查找引用 20 公式 22 地理位置 23 群组 1001/1002 创建/修改时间 1003/1004 创建/修改人 1005 自动编号 */
const DATE_TYPES = new Set([5, 1001, 1002]);
function cellText(v, type, tz) {
  if (v == null) return '';
  if (DATE_TYPES.has(type) && (typeof v === 'number' || /^\d{10,13}$/.test(String(v)))) return fmtDate(+v, tz);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? '是' : '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    /* 富文本:[{type:'text',text}, {type:'mention',text}, {type:'url',text,link}] 直接拼接 */
    if (v.length && v.every(x => x && typeof x === 'object' && typeof x.text === 'string' && /^(text|url|mention)$/.test(x.type || ''))) return v.map(x => x.text).join('');
    return v.map(x => cellText(x, type, tz)).filter(Boolean).join('、');
  }
  if (typeof v === 'object') {
    if ('value' in v && 'type' in v) return cellText(v.value, typeof v.type === 'number' ? v.type : type, tz); /* 公式 / 查找引用 */
    if (Array.isArray(v.text_arr)) return v.text_arr.join('、');
    const s = v.text != null ? v.text : (v.name != null ? v.name : (v.en_name != null ? v.en_name : (v.full_address != null ? v.full_address : (v.link != null ? v.link : (v.email != null ? v.email : '')))));
    return String(s);
  }
  return String(v);
}
/* 字段 + 记录 → 二维数组(首行为字段名),交给现有的表格导入映射 */
function bitableRows(fields, records, tz) {
  const fs = (fields || []).filter(f => f && f.field_name);
  const rows = [fs.map(f => f.field_name)];
  (records || []).forEach(r => { const f = (r && r.fields) || {}; rows.push(fs.map(x => cellText(f[x.field_name], x.type, tz))); });
  return rows;
}
/* 导出记录:日期字段转毫秒、数字字段转数值,空值不写 */
function toBitableRecords(fields, records, tz) {
  return (records || []).map(r => {
    const out = {};
    fields.forEach(f => {
      let v = r[f.name];
      if (v == null || v === '') return;
      if (f.type === 5) v = dateMs(v, tz);
      else if (f.type === 2) v = Number(v);
      else v = String(v);
      if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return;
      out[f.name] = v;
    });
    return { fields: out };
  });
}
Object.assign(module.exports, { OWNER_WARN, MAX_ROWS, MAX_COLS, BITABLE_BATCH, colName, cellValue, normalizeValues, rangeFor, chunkValues, sheetName, uniqueName, withParam, fmtDate, dateMs, cellText, bitableRows, toBitableRecords });
