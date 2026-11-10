/* 一键导入 / 导出「生产进度计划表」
   导入:上传 .xlsx / .csv,或粘贴飞书电子表格链接 → 识别表头、工序、部门、日期、工期 → 生成项目草稿(可在前端修改)→ 创建项目
        配置了大模型时由 Claude 识别表格结构,否则用规则匹配
   导出:按「XX生产进度计划表(生产指令)」格式生成 .xlsx / .csv,或写入新的飞书电子表格 */
'use strict';
const X = require('./xlsx.js');
const llm = require('./llm.js');

module.exports = function (ctx) {
  const { E, store, route, json, fail, readJson, send } = ctx;

  /* ---------- 工序名称 → 标准工序 ---------- */
  const SYN = [
    ['epurchase', /电气.*(采购|外购|到货)|(采购|外购).*电气|电控.*采购|电器.*采购/],
    ['create', /立项|合同|评审|技术协议/],
    ['edesign', /电气|电控|电器|PLC|程序设计/i],
    ['pdesign', /工艺/],
    ['mdesign', /机械设计|结构设计|设计|出图|方案/],
    ['mpurchase', /采购|外购|备料|原材料|到料/],
    ['plan', /计划|排产/],
    ['cut', /下料|切割|落料|割板/],
    ['weld', /焊|组对|拼装/],
    ['machine', /机加|加工|镗|铣|车削/],
    ['paint', /涂装|喷漆|油漆|喷砂|喷涂|防腐|表面处理/],
    ['assemble', /装配|组装|调试|总装|安装/],
    ['test', /试验|检验|测试|验收|检测|试车/],
    ['pack', /包装|装箱/],
    ['ship', /发货|发运|运输|交付|物流/]
  ];
  function stdId(name) { for (const [id, re] of SYN) if (re.test(name)) return id; return null; }
  const STD_PLAN = {}; E.STD.forEach(s => { STD_PLAN[s[0]] = s; });

  /* ---------- 日期 ---------- */
  function parseDate(v, ctxYear) {
    v = String(v || '').trim(); if (!v) return null;
    let m = v.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    if (m) return { y: +m[1], m: +m[2], d: +m[3], hasYear: true };
    m = v.match(/^(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*日?$/);
    if (m) return { y: ctxYear, m: +m[1], d: +m[2], hasYear: false };
    if (/^\d{5}(\.\d+)?$/.test(v)) { const s = new Date(Date.UTC(1899, 11, 30) + Math.round(+v) * 86400000); return { y: s.getUTCFullYear(), m: s.getUTCMonth() + 1, d: s.getUTCDate(), hasYear: true }; }
    return null;
  }
  const toDate = p => new Date(p.y, p.m - 1, p.d);

  /* 状态列:「已完成」「进行中 40%」「40%」「未开始」 */
  function parseStatus(v) {
    v = String(v || '').trim(); if (!v) return null;
    if (/已完成|完成|done/i.test(v) && !/未完成/.test(v)) return { s: 'done', p: 100 };
    const m = v.match(/(\d{1,3})\s*%/); if (m) { const p = +m[1]; return p >= 100 ? { s: 'done', p: 100 } : { s: p > 0 ? 'active' : 'pending', p }; }
    if (/进行|在制|施工/.test(v)) return { s: 'active', p: 0 };
    if (/未开始|未开工|待/.test(v)) return { s: 'pending', p: 0 };
    return null;
  }
  /* ---------- 规则识别 ---------- */
  const HEAD = { seq: /^序号$|^No\.?$|^编号$/i, name: /制作流程|工序|流程|工作内容|任务|作业|项目内容|阶段/, dept: /部门|责任单位|车间|班组/, owner: /负责人|责任人|经办|执行人/,
    start: /开始|起始|计划开始|开工/, end: /结束|完成时间|完成日期|^完成$|截止|完工/, dur: /周期|工期|天数|用时|时长/, deps: /前置|依赖|紧前/, status: /^状态$|完成情况|执行情况|^进度$/ };
  function findHeader(rows) {
    let best = -1, bestScore = 0, map = null;
    for (let r = 0; r < Math.min(rows.length, 30); r++) {
      const row = rows[r] || [], m = {}; let score = 0;
      row.forEach((c, i) => { c = String(c || '').trim(); if (!c || c.length > 12) return;
        for (const k of Object.keys(HEAD)) if (m[k] == null && HEAD[k].test(c)) { m[k] = i; score += k === 'name' ? 3 : 1; break; } });
      if (m.name != null && score > bestScore) { best = r; bestScore = score; map = m; }
    }
    return best < 0 ? null : { row: best, map };
  }
  function ruleDraft(rows, filename) {
    const today = ctx.today(), warnings = [];
    const h = findHeader(rows);
    if (!h) throw Object.assign(new Error('没有找到表头:请确认表格中有「制作流程 / 工序」列'), { status: 400 });
    /* 标题:表头上方含「计划表 / 进度」的单元格 */
    let title = '';
    for (let r = 0; r < h.row; r++) for (const c of rows[r] || []) if (c && /计划|进度|指令/.test(c)) { title = String(c).trim(); break; }
    if (!title && filename) title = filename.replace(/\.(xlsx|csv|txt)$/i, '');
    const name = title.replace(/[（(]?生产指令[)）]?/, '').replace(/生产进度计划表|进度计划表|生产计划表|计划表/, '').trim() || '导入项目';
    let year = today.getFullYear();
    const ym = title.match(/(20\d{2})/); if (ym) year = +ym[1];
    const tasks = [], used = {}; let lastMonth = 0, n = 0;
    for (let r = h.row + 1; r < rows.length; r++) {
      const row = rows[r] || [], nm = String(row[h.map.name] || '').trim();
      if (!nm || /^(合计|总计|备注|说明|制表|审核|批准)/.test(nm) || nm === String(rows[h.row][h.map.name]).trim()) continue;
      if (h.map.seq != null && row[h.map.seq] && !/^\d+$/.test(String(row[h.map.seq]).trim()) && !nm) continue;
      let s = h.map.start != null ? parseDate(row[h.map.start], year) : null, e = h.map.end != null ? parseDate(row[h.map.end], year) : null;
      /* 无年份的「10月1日」跨年:月份变小则年份 +1 */
      [s, e].forEach(p => { if (p && !p.hasYear) { if (lastMonth && p.m < lastMonth - 6) { year++; p.y = year; } lastMonth = Math.max(lastMonth, p.m); } else if (p) { year = p.y; lastMonth = p.m; } });
      if (s && e && toDate(e) < toDate(s)) { e.y++; }
      let days = null; const dv = h.map.dur != null ? String(row[h.map.dur] || '').match(/(\d+(\.\d+)?)/) : null;
      if (dv) days = Math.max(1, Math.round(+dv[1]));
      else if (s && e) days = Math.round((toDate(e) - toDate(s)) / 864e5) + 1;
      const sid = stdId(nm);
      let id = sid && !used[sid] ? sid : 'x' + (++n);
      used[id] = 1;
      if (!days) { days = sid ? STD_PLAN[sid][3] : 5; warnings.push('「' + nm + '」没有工期,按 ' + days + ' 天估算'); }
      tasks.push({ id, std: sid && id === sid ? sid : null, name: nm, dept: h.map.dept != null ? String(row[h.map.dept] || '').trim() : '', owner: h.map.owner != null ? String(row[h.map.owner] || '').trim() : '',
        plan: days, start: s ? E.fmtFull(toDate(s)) : null, end: e ? E.fmtFull(toDate(e)) : null, depsText: h.map.deps != null ? String(row[h.map.deps] || '').trim() : '',
        status: h.map.status != null ? parseStatus(row[h.map.status]) : null });
    }
    if (!tasks.length) throw Object.assign(new Error('表头下方没有识别到工序'), { status: 400 });
    return finishDraft({ name, title, tasks, warnings, by: 'rule', header: rows[h.row] });
  }

  /* 前置关系:标准工序用标准工艺依赖(跳过表中没有的工序);其余按日期 / 行顺序 */
  function finishDraft(d) {
    const tasks = d.tasks, ids = new Set(tasks.map(t => t.id)), byName = {};
    tasks.forEach(t => { byName[t.name] = t.id; });
    function stdDeps(id) {
      const out = new Set();
      (function walk(x) { (E.STAGE_DEPS[x] || []).forEach(p => { if (ids.has(p)) out.add(p); else walk(p); }); })(id);
      return [...out];
    }
    tasks.forEach((t, i) => {
      if (t.depsText) { const ds = t.depsText.split(/[,，、;；\s]+/).map(s => byName[s] || (tasks[+s - 1] && tasks[+s - 1].id)).filter(x => x && x !== t.id); if (ds.length) { t.deps = [...new Set(ds)]; return; } }
      if (t.std) { const ds = stdDeps(t.std); if (ds.length || i === 0) { t.deps = ds; return; } }
      if (i === 0) { t.deps = []; return; }
      if (t.start) {
        const st = t.start, prev = tasks.slice(0, i).filter(p => p.end && p.end < st);
        if (prev.length) { const last = prev.reduce((a, b) => (b.end > a.end ? b : a)); t.deps = [last.id]; return; }
      }
      t.deps = [tasks[i - 1].id];
    });
    /* 非标准工序插在链路中间:原本依赖其前置的后续工序改为依赖它(如「装配」与「试验」之间的「调试」) */
    tasks.forEach((x, i) => {
      if (x.std || x.depsText || x.deps.length !== 1) return;
      const d = x.deps[0];
      tasks.slice(i + 1).forEach(t => { if (t.depsText) return; const k = t.deps.indexOf(d); if (k < 0) return;
        if (!x.end || !t.start || t.start > x.end) t.deps[k] = x.id; });
    });
    /* 去掉冗余前置:若 A 已是 B 的祖先,则只保留 B */
    const depMap = {}; tasks.forEach(t => { depMap[t.id] = t.deps; });
    function anc(id, seen) { seen = seen || new Set(); (depMap[id] || []).forEach(p => { if (!seen.has(p)) { seen.add(p); anc(p, seen); } }); return seen; }
    tasks.forEach(t => { t.deps = [...new Set(t.deps)]; t.deps = t.deps.filter(a => !t.deps.some(b => b !== a && anc(b).has(a))); });
    /* 部门:表中没有时用默认部门 */
    tasks.forEach(t => { if (!t.dept) t.dept = t.std ? E.DEPT_DEF[t.std] : ''; t.role = t.std ? STD_PLAN[t.std][2] : ''; t.desc = t.std ? STD_PLAN[t.std][4] : '导入的工序'; });
    const starts = tasks.map(t => t.start).filter(Boolean).sort();
    const contract = starts.length ? E.fmtFull(E.addDays(E.parseD(starts[0]), -1)) : E.fmtFull(ctx.today());
    const unmatched = tasks.filter(t => !t.std).map(t => t.name);
    if (unmatched.length) d.warnings.push('以下工序不在标准工艺中,按表格顺序 / 日期推断前置:' + unmatched.join('、'));
    const type = /AGV|小车/i.test(d.name) ? 'AGV小车类' : (/平车|KBK|轻轨/i.test(d.name) ? '电动平车/KBK类' : '起重机类');
    return { name: d.name, title: d.title, code: '', customer: d.customer || '', type, pm: '', contract, tasks, warnings: d.warnings, by: d.by, header: d.header || null };
  }

  /* ---------- 大模型识别(可选) ---------- */
  const SCHEMA = { type: 'object', additionalProperties: false, required: ['title', 'customer', 'tasks'], properties: {
    title: { type: 'string' }, customer: { type: 'string' },
    tasks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'std_id', 'dept', 'owner', 'start', 'end', 'days'], properties: {
      name: { type: 'string' }, std_id: { type: 'string', enum: E.STD.map(s => s[0]).concat(['none']) }, dept: { type: 'string' }, owner: { type: 'string' },
      start: { type: 'string', description: 'YYYY-MM-DD 或空串' }, end: { type: 'string', description: 'YYYY-MM-DD 或空串' }, days: { type: 'integer' } } } } } };
  async function llmDraft(rows, filename) {
    const tsv = rows.slice(0, 80).map(r => r.join('\t')).join('\n');
    const std = E.STD.map(s => s[0] + '=' + s[1]).join(';');
    const j = await llm.completeJson(
      '你负责把工厂的生产进度计划表(Excel 转成的 TSV)整理成结构化工序列表。只提取表中真实存在的工序行,不要编造。'
      + '日期统一为 YYYY-MM-DD(表中无年份时按今天 ' + E.fmtFull(ctx.today()) + ' 前后合理推断);工期 days 为天数(表中有周期列优先,否则用结束-开始+1)。'
      + 'std_id 从标准工序中选择最匹配的一个:' + std + ';不匹配填 none。dept 为表中的责任部门(合并单元格已展开)。title 为表格标题,customer 为客户(没有则空串)。',
      '文件名:' + (filename || '') + '\n\n' + tsv, SCHEMA, { maxTokens: 8000, effort: 'medium' });
    if (!j || !Array.isArray(j.tasks) || !j.tasks.length) return null;
    const used = {}; let n = 0;
    const tasks = j.tasks.map(t => {
      const sid = t.std_id && t.std_id !== 'none' && STD_PLAN[t.std_id] ? t.std_id : null;
      const id = sid && !used[sid] ? sid : 'x' + (++n); used[id] = 1;
      const ok = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null;
      return { id, std: sid && id === sid ? sid : null, name: String(t.name).slice(0, 30), dept: t.dept || '', owner: t.owner || '', plan: Math.max(1, t.days || (sid ? STD_PLAN[sid][3] : 5)), start: ok(t.start), end: ok(t.end), depsText: '' };
    });
    const title = j.title || '';
    const name = title.replace(/[（(]?生产指令[)）]?/, '').replace(/生产进度计划表|进度计划表|生产计划表|计划表/, '').trim() || (filename || '导入项目').replace(/\.\w+$/, '');
    return finishDraft({ name, title, customer: j.customer, tasks, warnings: [], by: 'llm' });
  }

  /* 宽表(一行一个项目):没有「制作流程 / 工序」列、但有「项目名称」和多组计划 / 实际完成时间列时走这条路,见 import_wide.js */
  const WIDE = require('./import_wide.js')(ctx, { parseDate, findHeader });
  async function parse(rows, filename, useLlm) {
    rows = rows.filter(r => r && r.some(c => String(c || '').trim()));
    if (!rows.length) throw Object.assign(new Error('表格是空的'), { status: 400 });
    if (!findHeader(rows)) {
      const det = WIDE.detect(rows);
      if (det) {
        const w = WIDE.parseWide(rows, filename, det);
        w.projects.forEach(p => { p.match = WIDE.findExisting(p); p.action = p.match ? 'update' : 'create'; });
        w.preview = rows.slice(0, 40).map(r => r.slice(0, 12));
        return w;
      }
    }
    let d = null;
    if (useLlm !== false && llm.ready()) d = await llmDraft(rows, filename);
    if (!d) d = ruleDraft(rows, filename);
    d.preview = rows.slice(0, 40).map(r => r.slice(0, 12));
    return d;
  }
  ctx.importParse = parse;

  route('POST', '/api/import/parse', async (req, res) => {
    const b = await readJson(req, 20e6);
    let rows, filename = String(b.filename || '');
    if (b.kind === 'feishu') {
      if (!ctx.feishu.appReady()) return fail(res, 400, '未配置飞书开放平台应用(.env 中的 FEISHU_APP_ID / FEISHU_APP_SECRET),暂时无法读取飞书表格。可以先在飞书中「下载为 Excel」再上传。');
      rows = await ctx.feishu.readDoc(String(b.url || ''));
      if (!filename && ctx.feishu.docTitle) filename = await ctx.feishu.docTitle(String(b.url || ''));
      filename = filename || '飞书表格';
    } else {
      const buf = Buffer.from(String(b.data || ''), 'base64');
      if (!buf.length) return fail(res, 400, '没有收到文件');
      if (/\.csv$|\.txt$/i.test(filename) || b.kind === 'csv') rows = X.readCsv(buf.toString('utf8'));
      else if (buf.readUInt32LE(0) === 0x04034b50) { const wb = X.read(buf); const sh = wb.sheets.find(s => findHeader(s.rows)) || wb.sheets[0]; rows = sh ? sh.rows : []; }
      else return fail(res, 400, '仅支持 .xlsx(Excel 2007 及以上)和 .csv 文件;.xls 请先另存为 .xlsx');
    }
    json(res, Object.assign({ ok: true }, await parse(rows, filename, b.llm)));
  });

  /* 批量创建 / 更新项目(宽表导入):projects 每项带 action = create | update | skip */
  route('POST', '/api/import/commit-batch', async (req, res) => {
    const b = await readJson(req, 20e6);
    if (!Array.isArray(b.projects) || !b.projects.length) return fail(res, 400, '没有项目');
    if (b.projects.length > 500) return fail(res, 400, '一次最多导入 500 个项目');
    json(res, Object.assign({ ok: true }, WIDE.commit(b.projects)));
  });

  /* 创建项目:可按表格日期推断已完成 / 进行中 */
  route('POST', '/api/import/commit', async (req, res) => {
    const b = await readJson(req, 5e6), d = b.draft || {};
    if (!Array.isArray(d.tasks) || !d.tasks.length) return fail(res, 400, '没有工序');
    const ids = new Set(d.tasks.map(t => String(t.id)));
    const pid = 'p' + Date.now().toString(36);
    const P = { id: pid, name: String(d.name || '导入项目').slice(0, 60), code: String(d.code || '').slice(0, 30), customer: String(d.customer || '').slice(0, 40), type: E.PTYPES.indexOf(d.type) >= 0 ? d.type : E.PTYPES[0], pm: String(d.pm || '').slice(0, 20),
      contract: E.parseD(d.contract) ? d.contract : E.fmtFull(ctx.today()),
      tasks: d.tasks.map(t => ({ id: String(t.id), name: String(t.name || '工序').slice(0, 30), role: String(t.role || ''), dept: String(t.dept || ''), owner: String(t.owner || ''), plan: Math.max(1, Math.min(365, Math.round(+t.plan || 1))),
        deps: (t.deps || []).map(String).filter(x => ids.has(x) && x !== String(t.id)), desc: String(t.desc || '导入的工序'), ps: t.start && b.keepDates ? t.start : undefined })) };
    /* 环路检查 */
    const order = E.topoOrder(P.tasks); if (order.length !== P.tasks.length) return fail(res, 400, '前置关系存在环路,请检查');
    E.prep(P, ctx.today());
    const ST = {}, off = s => Math.round((E.parseD(s) - P.cDate) / 864e5);
    P.tasks.forEach(t => {
      const src = d.tasks.find(x => String(x.id) === t.id), s = src.start && E.parseD(src.start) ? off(src.start) : null, e = src.end && E.parseD(src.end) ? off(src.end) : null;
      const xs = b.inferStatus && src.status;
      if (xs && xs.s === 'done') ST[t.id] = { s: 'done', p: 100, d: s != null && e != null ? e - s + 1 : t.plan, sa: s != null ? s : P.tDay - t.plan, ea: e != null ? Math.min(e, P.tDay) : P.tDay, cf: true };
      else if (xs && xs.s === 'active') ST[t.id] = { s: 'active', p: Math.min(95, xs.p), d: Math.max(t.plan, s != null && e != null ? e - s + 1 : t.plan), sa: s != null ? Math.min(s, P.tDay) : P.tDay, ea: null };
      else if (xs && xs.s === 'pending') ST[t.id] = { s: 'pending', p: 0, d: t.plan, sa: null, ea: null };
      else if (b.inferStatus && s != null && e != null && e < P.tDay) ST[t.id] = { s: 'done', p: 100, d: e - s + 1, sa: s, ea: e, cf: true };
      else if (b.inferStatus && s != null && s <= P.tDay) { const dd = Math.max(t.plan, (e != null ? e - s + 1 : t.plan)); ST[t.id] = { s: 'active', p: Math.max(0, Math.min(95, Math.round((P.tDay - s) / dd * 100))), d: dd, sa: s, ea: null }; }
      else ST[t.id] = { s: 'pending', p: 0, d: t.plan, sa: null, ea: null };
    });
    delete P.cDate; delete P.tDay; P.tasks.forEach(t => { if (t.ps === undefined) delete t.ps; });
    store.data.defs.push(P); store.data.projects[pid] = { tasks: ST }; store.data.rev[pid] = 1;
    store.changed([pid]);
    ctx.broadcast('data', { version: store.data.version, origin: null, pids: [pid] });
    json(res, { ok: true, pid });
  });

  /* ---------- 导出:生产进度计划表 ---------- */
  function sheetFor(pid) {
    const x = store.compute(pid); if (!x) return null;
    const { P, ST, c } = x, S = X.STYLES, md = d => (d.getMonth() + 1) + '月' + d.getDate() + '日';
    const order = c.order, D = n => E.addDays(P.cDate, n);
    const t0 = Math.min(...order.map(t => Math.min(c.fs[t.id], c.pb[t.id]))), t1 = Math.max(...order.map(t => Math.max(c.fe[t.id], c.pe[t.id])));
    const days = []; for (let i = t0; i <= t1; i++) days.push(i);
    const FIX = ['序号', '制作流程', '责任部门', '负责人', '开始时间', '结束时间', '流程周期', '状态'], NF = FIX.length;
    const title = P.name + '生产进度计划表(生产指令)';
    const rows = [[{ v: title, s: S.title }], [], []], merges = ['A1:' + X.colName(NF + days.length - 1) + '1'];
    FIX.forEach((h, i) => { rows[1][i] = { v: h, s: S.head }; rows[2][i] = { v: '', s: S.head }; merges.push(X.colName(i) + '2:' + X.colName(i) + '3'); });
    /* 月份行 + 日期行 */
    let ms = 0;
    days.forEach((n, k) => {
      const d = D(n), col = NF + k;
      rows[2][col] = { v: d.getDate(), s: d.getDay() === 0 || d.getDay() === 6 ? S.weekend : S.cell };
      const last = k === days.length - 1 || D(days[k + 1]).getMonth() !== d.getMonth();
      if (last) { rows[1][NF + ms] = { v: (d.getMonth() + 1) + '月份', s: S.head }; for (let j = ms + 1; j <= k; j++) rows[1][NF + j] = { v: '', s: S.head }; if (k > ms) merges.push(X.colName(NF + ms) + '2:' + X.colName(NF + k) + '2'); ms = k + 1; }
    });
    let deptStart = 3; const list = [];
    order.forEach((t, i) => {
      const st = ST[t.id], r = 3 + i, s = c.fs[t.id], e = c.fe[t.id];
      const status = st.s === 'done' ? '已完成' : (st.s === 'active' ? '进行中 ' + st.p + '%' : '未开始');
      const row = [{ v: i + 1, s: S.cell }, { v: t.name, s: S.left }, { v: E.deptOf(t), s: S.cell }, { v: t.owner || '', s: S.cell }, { v: md(D(s)), s: S.cell }, { v: md(D(e)), s: S.cell }, { v: (e - s + 1) + '天', s: S.cell }, { v: status, s: S.cell }];
      days.forEach(n => {
        let sty = S.cell;
        if (n >= s && n <= e) sty = n > c.re[t.id] && st.s !== 'done' && c.vr[t.id] > 0 ? S.late : (st.s === 'done' ? S.done : (st.s === 'active' ? S.active : S.pending));
        else if (n >= c.pb[t.id] && n <= c.pe[t.id]) sty = S.base;
        row.push({ v: '', s: sty });
      });
      rows[r] = row;
      list.push({ '制作流程': t.name, '序号': i + 1, '责任部门': E.deptOf(t), '负责人': t.owner || '', '开始时间': E.fmtFull(D(s)), '结束时间': E.fmtFull(D(e)), '流程周期': e - s + 1, '状态': status, '进度(%)': st.p });
      /* 责任部门:相同部门的连续行合并 */
      const next = order[i + 1];
      if (!next || E.deptOf(next) !== E.deptOf(t)) { if (r > deptStart) merges.push('C' + (deptStart + 1) + ':C' + (r + 1)); deptStart = r + 1; }
    });
    const s = E.summarize(P, ST, c), foot = 3 + order.length + 1;
    const footText = '合同签订 ' + P.contract + ' · 计划交付 ' + E.fmtFull(s.plan) + ' · 预测交付 ' + E.fmtFull(s.fc) + (s.delay > 0 ? '(晚 ' + s.delay + ' 天)' : '') + ' · 图例:绿=已完成 蓝=进行中 灰=未开始 红=超出本工序计划 浅黄=基线计划 · 导出自擎图交付管家';
    rows[foot] = [{ v: footText, s: S.normal }];
    return { P, rows, merges, list, footText, FIX, sheet: { name: (P.code || '计划表'), rows, merges, cols: [5, 14, 12, 9, 9, 9, 8, 10].concat(days.map(() => 3.2)), heights: { 0: 30 }, freeze: { row: 3, col: NF } }, title };
  }
  const fname = (P, ext) => encodeURIComponent((P.code ? P.code + '-' : '') + P.name + '-生产进度计划表.' + ext);
  route('GET', '/api/export/:pid.xlsx', (req, res) => {
    const s = sheetFor(req.params.pid); if (!s) return fail(res, 404, '未找到该项目');
    send(res, 200, X.write(s.sheet), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { 'Content-Disposition': "attachment; filename*=UTF-8''" + fname(s.P, 'xlsx') });
  });
  route('GET', '/api/export/:pid.csv', (req, res) => {
    const s = sheetFor(req.params.pid); if (!s) return fail(res, 404, '未找到该项目');
    const plain = s.rows.slice(1, 3 + s.P.tasks.length).map((r, i) => i === 0 ? r.slice(0, 8) : (i === 1 ? null : r.slice(0, 8))).filter(Boolean);
    send(res, 200, X.writeCsv([[s.title]].concat(plain)), 'text/csv; charset=utf-8', { 'Content-Disposition': "attachment; filename*=UTF-8''" + fname(s.P, 'csv') });
  });
  /* 写入飞书的纯值表:标题 / 表头 / 工序行(固定 8 列)/ 空行 / 说明;不含甘特日期列(飞书写值不带颜色) */
  function plainRows(s) {
    const v = c => c == null ? '' : (typeof c === 'object' ? c.v : c);
    const body = [];
    for (let i = 3; i < 3 + s.list.length; i++) body.push(Array.from((s.rows[i] || []).slice(0, s.FIX.length), v));
    return [[s.title], s.FIX.slice()].concat(body, [[], [s.footText]]);
  }
  /* 多维表格字段:首列(主字段)为工序名称 */
  const BT_FIELDS = [{ name: '制作流程', type: 1 }, { name: '序号', type: 2, property: { formatter: '0' } }, { name: '责任部门', type: 1 }, { name: '负责人', type: 1 },
    { name: '开始时间', type: 5, property: { date_formatter: 'yyyy/MM/dd' } }, { name: '结束时间', type: 5, property: { date_formatter: 'yyyy/MM/dd' } },
    { name: '流程周期', type: 2, property: { formatter: '0' } }, { name: '状态', type: 1 }, { name: '进度(%)', type: 2, property: { formatter: '0' } }];
  ctx.plainRows = plainRows; ctx.BT_FIELDS = BT_FIELDS;
  /* 导出到飞书:body { target: 'sheet' | 'bitable', url?: 已有电子表格 / 多维表格 / 知识库链接 } */
  route('POST', '/api/export/:pid/feishu', async (req, res) => {
    const s = sheetFor(req.params.pid); if (!s) return fail(res, 404, '未找到该项目');
    if (!ctx.feishu.appReady()) return fail(res, 400, '未配置飞书开放平台应用(FEISHU_APP_ID / FEISHU_APP_SECRET),可先「导出 Excel」后上传到飞书');
    const b = await readJson(req, 1e5);
    const label = (s.P.code ? s.P.code + ' ' : '') + s.P.name + ' ' + E.fmtFull(ctx.today());
    const out = await ctx.feishu.exportDoc({ target: b.target, url: String(b.url || '').trim(), title: s.title, sheetTitle: label, rows: plainRows(s),
      bitable: { fields: BT_FIELDS, records: s.list } });
    json(res, Object.assign({ ok: true }, out));
  });
  ctx.sheetFor = sheetFor;
  /* 示例表格下载 */
  route('GET', '/api/samples/:name', (req, res) => {
    const fs = require('fs'), path = require('path'), dir = path.join(ctx.root, 'samples');
    const f = fs.readdirSync(dir).find(x => x === req.params.name);
    if (!f) return fail(res, 404, '未找到');
    send(res, 200, fs.readFileSync(path.join(dir, f)), /\.csv$/.test(f) ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(f) });
  });
};
