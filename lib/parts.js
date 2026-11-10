/* 客户进度链接:/c/<token> 只读页面。只输出里程碑级信息,不含内部部门、负责人、异常细节(除非老板开启) */
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = function (ctx) {
  const { E, store, route, json, fail, send } = ctx;
  const MS = [['合同与设计', ['create', 'plan', 'mdesign', 'pdesign', 'edesign']], ['采购备料', ['mpurchase', 'epurchase']], ['生产制造', ['cut', 'weld', 'machine', 'paint']],
    ['组装调试', ['assemble']], ['试验验收', ['test']], ['包装发货', ['pack', 'ship']]];
  const FRIENDLY = { '缺料': '物料到货延迟', '外购件未到': '外购件到货延迟', '设备': '设备故障检修', '返工': '质量返工', '图纸问题': '技术方案调整', '等上工序 / 排队': '生产排程调整', '未登记原因': '生产进度调整', '其他': '生产进度调整' };

  route('GET', '/c/:token', (req, res) => send(res, 200, fs.readFileSync(path.join(ctx.root, 'c.html')), 'text/html; charset=utf-8'));
  route('GET', '/api/c/:token', (req, res) => {
    const tok = String(req.params.token || '');
    const P0 = tok.length >= 12 && store.data.defs.find(P => P.share && P.share.on && P.share.token === tok);
    if (!P0) return fail(res, 404, '链接已失效或不存在,请联系项目负责人');
    const { P, ST, c } = store.compute(P0.id), show = P0.share.show || {};
    const s = E.summarize(P, ST, c), day = n => E.fmtFull(E.addDays(P.cDate, n));
    /* 工序 → 里程碑;非标准工序归入其前置所在的里程碑 */
    const grp = {}; MS.forEach((m, i) => m[1].forEach(id => { grp[id] = i; }));
    c.order.forEach(t => { if (grp[t.id] == null) grp[t.id] = t.deps.length ? Math.max(...t.deps.map(d => grp[d] || 0)) : 0; });
    const ms = MS.map((m, i) => {
      const ts = c.order.filter(t => grp[t.id] === i); if (!ts.length) return null;
      const w = ts.reduce((a, t) => a + t.plan, 0), pr = ts.reduce((a, t) => a + t.plan * ST[t.id].p, 0) / w;
      const st = ts.every(t => ST[t.id].s === 'done') ? 'done' : (ts.some(t => ST[t.id].s !== 'pending') ? 'active' : 'pending');
      const o = { name: m[0], s: st, pct: show.steps ? Math.round(pr) : null };
      if (show.dates) { o.start = day(Math.min(...ts.map(t => c.fs[t.id]))); o.end = day(Math.max(...ts.map(t => c.fe[t.id]))); }
      return o;
    }).filter(Boolean);
    const out = { ok: true, today: E.fmtFull(ctx.today()), project: { name: P.name, code: P.code, customer: P.customer }, milestones: ms, done: s.allDone,
      pct: Math.round(c.order.reduce((a, t) => a + t.plan * ST[t.id].p, 0) / c.order.reduce((a, t) => a + t.plan, 0)) };
    if (show.dates) { out.fc = E.fmtFull(s.fc); out.plan = E.fmtFull(s.plan); }
    if (show.delay && s.delay > 0) {
      const L = E.ledger(P, ST, c, store.data.events.filter(e => e.pid === P.id)), why = {};
      L.items.forEach(it => Object.keys(it.causes).forEach(k => { const f = FRIENDLY[k] || '生产进度调整'; why[f] = (why[f] || 0) + (it.causes[k] || 0); }));
      out.delay = { days: s.delay, reasons: Object.keys(why).filter(k => why[k] > 0).sort((a, b) => why[b] - why[a]).slice(0, 3) };
    }
    if (show.updates || show.photos) {
      const names = {}; P.tasks.forEach(t => { names[t.id] = t.name; });
      out.updates = store.data.events.filter(e => e.pid === P.id && (e.action === 'start' || e.action === 'done' || (show.photos && e.photo && (show.delay || e.action !== 'issue')))).slice(0, 20)
        .map(e => ({ ts: e.ts, text: e.action === 'start' ? names[e.tid] + ' 开始' : (e.action === 'done' ? names[e.tid] + ' 完成' : names[e.tid] + ' 现场照片'), photo: show.photos && e.photo ? e.photo : null }))
        .filter(u => show.updates || u.photo);
    }
    json(res, out);
  });
};
