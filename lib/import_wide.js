/* 宽表导入:「一行一个项目」的计划 / 实际表(如飞书多维表格「项目执行表」)
   表头里有「项目名称」,以及多组「设计开始时间 / 设计计划完成时间 / 设计实际完成时间 / 采购… / 生产… / 包装… / 发货…」列,
   没有「制作流程 / 工序」列。每行生成一个项目,每个环节生成一道工序。
   识别全部靠关键词 / 正则,不依赖列顺序,容忍字段名的小差异。 */
'use strict';

module.exports = function (ctx, h) {
  const { E } = ctx;
  const DAY = 864e5;

  /* ---------- 环节(按业务先后排序)---------- */
  /* core:表头里出现该环节的列就一定生成工序;其余环节只有该行有数据才生成。
     point:只有完成日期的「节点型」环节,计划工期 1 天;其余为「过程型」,可由上一环节结束推算开始时间。 */
  const STAGES = [
    { key: 'site', name: '厂外调试', id: 'site', std: null, dept: '售后部', role: '调试 / 售后', est: 5, point: true, re: /出厂后|厂外|现场调试|售后/ },
    { key: 'debug', name: '厂内调试', id: 'assemble', std: 'assemble', dept: E.DEPT_DEF.assemble, role: '装配调试组', est: 12, point: true, re: /调试/ },
    { key: 'design', name: '设计', id: 'mdesign', std: 'mdesign', dept: E.DEPT_DEF.mdesign, role: '设计师', est: 16, core: true, re: /设计/ },
    { key: 'purchase', name: '采购', id: 'mpurchase', std: 'mpurchase', dept: E.DEPT_DEF.mpurchase, role: '采购员', est: 12, core: true, re: /采购/ },
    { key: 'pack', name: '包装', id: 'pack', std: 'pack', dept: E.DEPT_DEF.pack, role: '包装班组', est: 2, point: true, core: true, re: /包装/ },
    { key: 'ship', name: '发货', id: 'ship', std: 'ship', dept: E.DEPT_DEF.ship, role: '物流专员', est: 2, point: true, core: true, re: /发货|发运/ },
    { key: 'make', name: '生产', id: 'make', std: null, dept: E.DEPT_DEF.weld, role: '生产班组', est: 24, core: true, re: /生产|制造|加工/ }
  ];
  /* 流程顺序(识别列时按 STAGES 顺序匹配,流程用这个顺序) */
  const ORDER = ['design', 'purchase', 'make', 'debug', 'pack', 'ship', 'site'];
  const STAGE = {}; STAGES.forEach(s => { STAGE[s.key] = s; });

  /* ---------- 表头分类 ---------- */
  const PROJECT_COLS = [
    ['name', /^项目名称$|^项目名$|^项目$|^工程名称$/],
    ['code', /合同编号|合同号|项目编号|订单号|订单编号/],
    ['equip', /设备需求|设备名称|产品名称|设备$|产品$/],
    ['sales', /销售/],
    ['customer', /客户/],
    ['due', /^合同交货期$|^合同交期$|^合同交货|^合同约定/],
    ['shipped', /^实际(发货|交付|发运)/],
    ['planDeliver', /^(计划|预计|承诺)(交付|发货|交货|发运)(时间|日期)?$/],
    ['closed', /关闭(时间|日期)?$/]
  ];
  const NOTE_COL = /问题|描述|结果|界定|考核|要求|备注|说明/;
  function role(head) {
    if (/负责人|人员|责任人|经办/.test(head)) return 'owner';
    if (/进度|记录/.test(head)) return 'note';
    if (/开始|起始|开工/.test(head)) return 'start';
    if (/计划(完成|结束|完工)|预计(完成|结束)/.test(head)) return 'planEnd';
    if (/实际|完成(时间|日期)?$|结束|完工/.test(head)) return 'actEnd';
    return null;
  }
  /* 把一行表头分类为 {name, code, …, stages:{key:{start,planEnd,actEnd,owner,note:[…]}}, notes:[{col,label}]} */
  function classify(head) {
    const cols = { stages: {}, notes: [] };
    head.forEach((c, i) => {
      c = String(c == null ? '' : c).replace(/\s+/g, '').trim(); if (!c || c.length > 24) return;
      for (const [k, re] of PROJECT_COLS) if (re.test(c)) { if (cols[k] == null) cols[k] = i; return; }
      const st = STAGES.find(s => s.re.test(c));
      if (st) {
        const r = role(c); if (!r) return;
        const g = cols.stages[st.key] || (cols.stages[st.key] = { note: [] });
        if (r === 'note') g.note.push({ col: i, label: c }); else if (g[r] == null) g[r] = i;
        return;
      }
      if (NOTE_COL.test(c) && !/时间|日期/.test(c)) cols.notes.push({ col: i, label: c });
    });
    /* 发货环节的计划 / 实际日期来自项目级的「计划交付时间」「实际发货时间」*/
    if (cols.planDeliver != null || cols.shipped != null) {
      const g = cols.stages.ship || (cols.stages.ship = { note: [] });
      if (g.planEnd == null && cols.planDeliver != null) g.planEnd = cols.planDeliver;
      if (g.actEnd == null && cols.shipped != null) g.actEnd = cols.shipped;
    }
    return cols;
  }
  const dateCols = g => ['start', 'planEnd', 'actEnd'].filter(k => g[k] != null).length;
  /* 识别宽表:有项目名称列 + 至少 2 个环节带日期列。在前 10 行里找表头行 */
  function detect(rows) {
    let best = null;
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
      const cols = classify(rows[r] || []);
      if (cols.name == null) continue;
      const groups = Object.keys(cols.stages).filter(k => dateCols(cols.stages[k]) > 0);
      if (groups.length < 2) continue;
      const score = groups.length * 10 + Object.keys(cols).filter(k => typeof cols[k] === 'number').length;
      if (!best || score > best.score) best = { row: r, cols, score, groups };
    }
    return best;
  }

  /* ---------- 日期工具(全部用 YYYY-MM-DD 字符串,避免时区问题)---------- */
  const D = s => { const a = String(s).split('-'); return Date.UTC(+a[0], +a[1] - 1, +a[2]); };
  const fmt = ms => new Date(ms).toISOString().slice(0, 10);
  const add = (s, n) => fmt(D(s) + n * DAY);
  const diff = (a, b) => Math.round((D(a) - D(b)) / DAY);
  const cell = v => String(v == null ? '' : v).trim();
  function pdate(v, year) {
    const p = h.parseDate(cell(v), year); if (!p || !p.m || !p.d) return null;
    const y = p.y || year, s = y + '-' + String(p.m).padStart(2, '0') + '-' + String(p.d).padStart(2, '0');
    return isNaN(D(s)) ? null : s;
  }
  /* 进度记录里「年   月  日,xxx完成;」是未填写的模板行,去掉 */
  function cleanNote(t) {
    return String(t || '').split(/\n+/).map(s => s.trim()).filter(s => s && !/^年\s*月\s*日/.test(s)).join(';').replace(/;{2,}/g, ';').replace(/[;;]$/, '');
  }

  /* ---------- 单行 → 项目草稿 ---------- */
  function rowDraft(row, cols, today, idx) {
    const T = E.fmtFull(today), year = today.getFullYear(), warn = [];
    const at = i => i == null ? '' : cell(row[i]);
    const name = at(cols.name).replace(/\s*\n\s*/g, ' ').trim();
    const stages = ORDER.filter(k => cols.stages[k]).map(k => {
      const g = cols.stages[k], S = STAGE[k];
      const t = { key: k, id: S.id, std: S.std, name: S.name, dept: S.dept, role: S.role, owner: at(g.owner).replace(/\s*\n\s*/g, '、'),
        start: g.start != null ? pdate(row[g.start], year) : null, pe: g.planEnd != null ? pdate(row[g.planEnd], year) : null, ae: g.actEnd != null ? pdate(row[g.actEnd], year) : null,
        note: g.note.map(n => { const x = cleanNote(row[n.col]); return x ? n.label + ':' + x : ''; }).filter(Boolean).join('\n') };
      return t;
    });
    const ship = stages.find(s => s.key === 'ship');
    /* 同一环节的多个负责人列(厂内调试人员 + AGV调试负责人;厂外调试人员 + 售后负责人)去重合并 */
    mergeOwners(stages, cols, row);
    /* 只有该行有数据的节点型环节才生成(厂内 / 厂外调试);核心环节只要表头有就生成 */
    const kept = stages.filter(t => STAGE[t.key].core || t.start || t.pe || t.ae || t.owner || t.note);
    /* 过滤不合理日期 */
    kept.forEach(t => {
      if (t.ae && t.ae > T) { warn.push('「' + t.name + '」实际完成日期 ' + t.ae + ' 晚于今天,按未完成处理'); t.ae = null; }
      if (t.start && t.pe && t.pe < t.start) { warn.push('「' + t.name + '」计划完成(' + t.pe.slice(5) + ')早于开始时间(' + t.start.slice(5) + '),计划完成日期已忽略,请核对'); t.pe = null; }
    });
    /* 开始时间:过程型环节缺开始时间时,按上一环节结束 + 1 天推算(不合理则留空)*/
    const inferred = [];
    kept.forEach((t, i) => {
      const S = STAGE[t.key], end = t.ae || t.pe;
      if (S.point) { if (!t.start) { t.start = t.pe || t.ae || null; t.milestone = true; } return; }
      if (t.start || !end) return;
      let prev = null; kept.slice(0, i).forEach(p => { const e = p.ae || p.pe; if (e && (!prev || e > prev)) prev = e; });
      if (prev) { const s = add(prev, 1); if (s <= end && diff(end, s) < 120) { t.start = s; t.inferredStart = true; inferred.push(t.name); return; } }
    });
    if (inferred.length) warn.push('「' + inferred.join('」「') + '」缺开始时间,按上一环节结束的次日推算');
    /* 工期 / 状态 */
    kept.forEach(t => {
      const S = STAGE[t.key], pend = t.pe || null;
      if (t.milestone) t.plan = 1;
      else if (t.start && pend) t.plan = Math.max(1, diff(pend, t.start) + 1);
      else if (t.start && t.ae) t.plan = Math.max(1, diff(t.ae, t.start) + 1);
      else t.plan = S.est;
      t.planEstimated = !t.milestone && !((t.start && pend) || (t.start && t.ae));
    });
    const est = kept.filter(t => t.planEstimated).map(t => t.name + ' ' + t.plan + ' 天');
    if (est.length) warn.push('「' + est.join('」「') + '」没有计划完成日期,工期按标准估算');
    /* 前置关系:按日期推断,汇合到尚未被依赖的环节(并行的采购与生产最终汇合到调试)*/
    const endOf = t => t.ae || t.pe, leaves = [];
    kept.forEach((t, i) => {
      if (!i) { t.deps = []; leaves.push(t); return; }
      let deps;
      if (!STAGE[t.key].point && t.start) {
        const el = kept.slice(0, i).filter(p => endOf(p) && endOf(p) < t.start);
        deps = el.filter(p => leaves.includes(p));
        if (!deps.length && el.length) deps = [el.reduce((a, b) => (endOf(b) > endOf(a) ? b : a))];
      } else deps = leaves.slice();
      t.deps = deps.map(p => p.id);
      deps.forEach(p => { const k = leaves.indexOf(p); if (k >= 0) leaves.splice(k, 1); });
      leaves.push(t);
    });
    /* 状态:有实际完成 → 已完成;已到开始时间 → 进行中(节点型环节要等前置都完成);计划完成已过仍未完成 → 标记延期 */
    const byId = {}; kept.forEach(t => { byId[t.id] = t; });
    kept.forEach(t => {
      const pend = t.pe || null;
      if (t.ae) { t.status = { s: 'done', p: 100 }; return; }
      const late = !!(pend && pend < T);
      t.late = late; t.lateDays = late ? diff(T, pend) : 0;
      const ready = t.deps.every(d => byId[d] && byId[d].ae);
      if (t.start && t.start <= T && (!STAGE[t.key].point || ready)) { const p = late ? 95 : Math.max(0, Math.min(95, Math.round(diff(T, t.start) / t.plan * 100))); t.status = { s: 'active', p }; }
      else t.status = { s: 'pending', p: 0 };
    });
    const doneIdx = kept.map(t => t.status.s === 'done');
    const gaps = kept.filter((t, i) => !doneIdx[i] && doneIdx.slice(i + 1).some(Boolean) && !STAGE[t.key].point).map(t => t.name);
    if (gaps.length) warn.push('后续环节已有实际完成日期,但「' + gaps.join('」「') + '」没有实际完成日期,请核对');
    /* 项目备注 */
    const notes = [];
    if (at(cols.sales)) notes.push('销售工程师:' + at(cols.sales));
    if (at(cols.equip)) notes.push('设备需求:' + at(cols.equip).replace(/\s*\n\s*/g, ' '));
    const due = cols.due != null ? pdate(row[cols.due], year) : null, pd = ship && ship.pe;
    if (due) notes.push('合同交货期:' + due);
    if (pd) notes.push('计划交付:' + pd);
    if (cols.closed != null && pdate(row[cols.closed], year)) notes.push('项目关闭时间:' + pdate(row[cols.closed], year));
    cols.notes.forEach(n => { const x = cleanNote(row[n.col]); if (x) notes.push(n.label + ':' + x.replace(/\s*\n\s*/g, ' ')); });
    /* 合同签订日:表里最早的日期 - 1 天(与一行一工序导入一致)*/
    const all = []; kept.forEach(t => { [t.start, t.pe, t.ae].forEach(x => { if (x) all.push(x); }); });
    if (due) all.push(due);
    const contract = all.length ? add(all.sort()[0], -1) : T;
    const hay = name + ' ' + at(cols.equip);
    const type = /AGV|全向车|潜伏/i.test(hay) ? 'AGV小车类' : (/平车|KBK|轻轨/i.test(hay) ? '电动平车/KBK类' : '起重机类');
    const tasks = kept.map(t => ({ id: t.id, std: t.std, name: t.name, dept: t.dept, owner: t.owner, role: t.role, plan: t.plan, start: t.start, end: t.ae || t.pe || null, planEnd: t.pe, actualEnd: t.ae,
      status: t.status, deps: t.deps, late: t.late || false, lateDays: t.lateDays || 0, milestone: !!t.milestone, planEstimated: t.planEstimated, note: t.note, desc: t.std ? (E.STD.find(s => s[0] === t.std) || [])[4] || '' : '导入的工序' }));
    return { name: name || ('项目' + idx), code: at(cols.code).replace(/\s+/g, ''), customer: at(cols.customer), type, pm: '', sales: at(cols.sales), contract, due, note: notes.join('\n'), tasks, warnings: warn, row: idx };
  }
  /* 负责人合并:同一环节的多个负责人列(厂内调试人员 + AGV调试负责人;厂外调试人员 + 售后负责人)去重后用「、」连接 */
  function mergeOwners(stages, cols, row) {
    const owners = {};
    ORDER.forEach(k => { owners[k] = []; });
    /* classify 只保留每环节第一个负责人列;这里重新扫描全部表头列在 cols.ownerAll */
    (cols.ownerAll || []).forEach(o => { const v = cell(row[o.col]).replace(/\s*\n\s*/g, '、'); if (v && !owners[o.key].includes(v)) owners[o.key].push(v); });
    stages.forEach(t => { if (owners[t.key].length) t.owner = owners[t.key].join('、'); });
  }

  /* ---------- 整表 ---------- */
  function parseWide(rows, filename, det) {
    const today = ctx.today(), cols = det.cols, head = rows[det.row];
    /* 全部负责人列(同一环节可能有多列)*/
    cols.ownerAll = [];
    head.forEach((c, i) => { c = String(c == null ? '' : c).replace(/\s+/g, ''); if (!c || !/负责人|人员|责任人|经办/.test(c)) return;
      if (PROJECT_COLS.some(([, re]) => re.test(c))) return;
      const st = STAGES.find(s => s.re.test(c)); if (st && cols.stages[st.key]) cols.ownerAll.push({ col: i, key: st.key }); });
    const projects = [], warnings = [];
    for (let r = det.row + 1; r < rows.length; r++) {
      const row = rows[r] || []; if (!cell(row[cols.name])) continue;
      projects.push(rowDraft(row, cols, today, r + 1));
    }
    if (!projects.length) throw Object.assign(new Error('表头下方没有识别到项目'), { status: 400 });
    const codes = {}, names = {};
    projects.forEach((p, i) => { p.key = 'w' + (i + 1);
      if (p.code) { if (codes[p.code] != null) p.warnings.push('合同编号「' + p.code + '」在表中重复出现(与第 ' + (codes[p.code] + 1) + ' 个项目相同)'); else codes[p.code] = i; }
      else if (names[p.name] != null) p.warnings.push('项目名称「' + p.name + '」在表中重复出现'); names[p.name] = i; });
    const ids = ORDER.filter(k => cols.stages[k]);
    return { wide: true, by: 'wide', title: (filename || '').replace(/\.(xlsx|csv|txt)$/i, ''), projects, warnings,
      stages: ids.map(k => STAGE[k].name), preview: rows.slice(0, 40).map(r => r.slice(0, 12)) };
  }

  /* ---------- 创建 / 更新项目 ---------- */
  const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();
  /* 已有项目匹配:合同编号相同优先,其次项目名称相同 */
  function findExisting(d) {
    const defs = ctx.store.data.defs;
    if (norm(d.code)) { const p = defs.find(x => norm(x.code) === norm(d.code)); if (p) return { pid: p.id, name: p.name, code: p.code, by: 'code' }; }
    const n = norm(d.name); if (n) { const p = defs.find(x => norm(x.name) === n); if (p) return { pid: p.id, name: p.name, code: p.code, by: 'name' }; }
    return null;
  }
  /* 草稿 → 项目定义 + 工序状态(日序号以合同签订日为 0)*/
  function build(d, pid) {
    const ids = new Set(d.tasks.map(t => String(t.id)));
    const P = { id: pid, name: String(d.name || '导入项目').slice(0, 60), code: String(d.code || '').slice(0, 30), customer: String(d.customer || '').slice(0, 40), type: E.PTYPES.indexOf(d.type) >= 0 ? d.type : E.PTYPES[0], pm: String(d.pm || '').slice(0, 20),
      contract: E.parseD(d.contract) ? d.contract : E.fmtFull(ctx.today()), note: String(d.note || '').slice(0, 2000), sales: String(d.sales || '').slice(0, 20), due: E.parseD(d.due) ? d.due : '',
      tasks: d.tasks.map(t => { const o = { id: String(t.id), name: String(t.name || '工序').slice(0, 30), role: String(t.role || ''), dept: String(t.dept || ''), owner: String(t.owner || '').slice(0, 40), plan: Math.max(1, Math.min(365, Math.round(+t.plan || 1))),
        deps: (t.deps || []).map(String).filter(x => ids.has(x) && x !== String(t.id)), desc: String(t.desc || '导入的工序') };
        if (t.start && E.parseD(t.start)) o.ps = t.start;
        if (t.note) o.note = String(t.note).slice(0, 1000); return o; }) };
    if (E.topoOrder(P.tasks).length !== P.tasks.length) return { error: '前置关系存在环路' };
    E.prep(P, ctx.today());
    const off = s => Math.round((E.parseD(s) - P.cDate) / DAY), ST = {};
    P.tasks.forEach(t => {
      const src = d.tasks.find(x => String(x.id) === t.id), st = src.status || { s: 'pending', p: 0 };
      const s = src.start && E.parseD(src.start) ? off(src.start) : null, e = src.actualEnd && E.parseD(src.actualEnd) ? off(src.actualEnd) : null;
      if (st.s === 'done' && e != null) { const sa = s != null && s <= e ? s : Math.max(0, e - (src.milestone ? 0 : t.plan - 1)); ST[t.id] = { s: 'done', p: 100, d: e - sa + 1, sa, ea: e, cf: true }; }
      else if (st.s === 'active' && s != null) ST[t.id] = { s: 'active', p: Math.max(0, Math.min(95, Math.round(st.p || 0))), d: t.plan, sa: Math.min(s, P.tDay), ea: null };
      else ST[t.id] = { s: 'pending', p: 0, d: t.plan, sa: null, ea: null };
    });
    delete P.cDate; delete P.tDay;
    return { P, ST };
  }
  /* 批量提交:projects: [{…草稿, action: 'create' | 'update' | 'skip'}]
     策略:合同编号(其次项目名称)与已有项目相同 → 默认「更新」:保留项目 id、零件清单和现场上报记录,
     用表中的项目信息、工序、计划 / 实际日期整体替换;不想覆盖的可在预览里改为「新建」或「跳过」。 */
  function commit(list) {
    const store = ctx.store, out = { created: [], updated: [], skipped: [], failed: [] }, pids = [];
    list.forEach((d, i) => {
      const act = d.action || 'create';
      if (act === 'skip') { out.skipped.push({ name: d.name }); return; }
      if (!Array.isArray(d.tasks) || !d.tasks.length) { out.failed.push({ name: d.name, error: '没有工序' }); return; }
      const ex = act === 'update' ? findExisting(d) : null;
      const pid = ex ? ex.pid : 'p' + Date.now().toString(36) + i.toString(36);
      const r = build(d, pid);
      if (r.error) { out.failed.push({ name: d.name, error: r.error }); return; }
      if (ex) {
        const old = store.def(pid), k = store.data.defs.findIndex(x => x.id === pid);
        store.data.defs[k] = Object.assign({}, old, r.P);
        store.data.projects[pid] = Object.assign({}, store.data.projects[pid], { tasks: r.ST });
        store.data.rev[pid] = (store.data.rev[pid] || 0) + 1;
        out.updated.push({ pid, name: r.P.name });
      } else {
        store.data.defs.push(r.P); store.data.projects[pid] = { tasks: r.ST }; store.data.rev[pid] = 1;
        out.created.push({ pid, name: r.P.name });
      }
      pids.push(pid);
    });
    if (pids.length) { store.changed(pids); ctx.broadcast('data', { version: store.data.version, origin: null, pids }); }
    return out;
  }
  return { detect, parseWide, findExisting, commit, build, classify };
};
