/* 扫码报工:手机页 + 报工 API。二维码内容为 <baseUrl>/r/<项目>/<工序> */
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = function (ctx) {
  const { E, store, route, json, fail, readJson, send } = ctx;
  ctx.onReport = ctx.onReport || [];
  const mPage = () => fs.readFileSync(path.join(ctx.root, 'm.html'));

  route('GET', '/r/:pid', (req, res) => send(res, 200, mPage(), 'text/html; charset=utf-8'));
  route('GET', '/r/:pid/:tid', (req, res) => send(res, 200, mPage(), 'text/html; charset=utf-8'));

  /* 手机页数据:项目 + 每道工序的计划 / 预测 / 状态 */
  function view(pid) {
    const x = store.compute(pid); if (!x) return null;
    const { P, ST, c } = x, s = E.summarize(P, ST, c), day = n => E.fmtFull(E.addDays(P.cDate, n));
    const names = {}; P.tasks.forEach(t => { names[t.id] = t.name; });
    const tasks = c.order.map(t => {
      const st = ST[t.id], vr = c.vr[t.id];
      return { id: t.id, name: t.name, dept: E.deptOf(t), owner: t.owner || '', role: t.role || '', s: st.s, p: st.p, cf: !!st.cf, by: st.by || null, blk: st.blk || null,
        plan: [day(c.rb[t.id]), day(c.re[t.id])], fc: [day(c.fs[t.id]), day(c.fe[t.id])], dev: vr, crit: !!c.crit[t.id],
        deps: t.deps.filter(d => names[d]).map(d => ({ id: d, name: names[d], s: ST[d].s, cf: !!ST[d].cf })),
        succ: P.tasks.filter(y => y.deps.indexOf(t.id) >= 0).map(y => ({ id: y.id, name: y.name, s: ST[y.id].s })) };
    });
    return {
      ok: true, today: E.fmtFull(ctx.today()),
      project: { id: P.id, name: P.name, code: P.code, customer: P.customer, pm: P.pm, type: P.type },
      summary: { plan: E.fmtFull(s.plan), fc: E.fmtFull(s.fc), delay: s.delay, allDone: s.allDone, stage: s.stage },
      tasks, events: store.data.events.filter(e => e.pid === pid).slice(0, 30), causes: E.CAUSES
    };
  }
  ctx.projectView = view;
  route('GET', '/api/r/:pid', (req, res) => { const v = view(req.params.pid); if (!v) return fail(res, 404, '未找到该项目'); json(res, v); });

  /* 报工 */
  route('POST', '/api/report', async (req, res) => {
    const b = await readJson(req, 12e6);
    const pid = String(b.pid || ''), tid = String(b.tid || ''), action = String(b.action || '');
    const P0 = store.def(pid);
    if (!P0) return fail(res, 404, '未找到该项目');
    const P = store.prepared(pid), ST = store.data.projects[pid].tasks;
    const before = E.summarize(P, ST);
    const r = E.applyReport(P, ST, tid, action, { p: b.p, cause: b.cause, note: b.note, days: b.days, force: !!b.force });
    if (!r.ok) return json(res, r, r.code === 'need_confirm' ? 200 : 400);
    if (r.code === 'noop') return json(res, r);
    const t = P.tasks.find(x => x.id === tid);
    const ev = { id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), day: E.fmtFull(ctx.today()), pid, tid, step: t.name, dept: E.deptOf(t),
      action, p: ST[tid].p, cause: action === 'issue' ? ST[tid].blk.cause : null, note: action === 'issue' ? ST[tid].blk.note : (b.note ? String(b.note).slice(0, 300) : ''),
      days: action === 'issue' ? ST[tid].blk.days : 0, who: String(b.who || '').slice(0, 20) || null, autoDone: r.autoDone, photo: null, msg: r.msg };
    if (b.photo && /^data:image\/(jpeg|png|webp);base64,/.test(b.photo)) {
      const ext = b.photo.slice(11, b.photo.indexOf(';')).replace('jpeg', 'jpg');
      const buf = Buffer.from(b.photo.slice(b.photo.indexOf(',') + 1), 'base64');
      if (buf.length < 10e6) { const f = ev.id + '.' + ext; fs.writeFileSync(path.join(store.dir, 'uploads', f), buf); ev.photo = 'uploads/' + f; }
    }
    store.data.events.unshift(ev);
    if (store.data.events.length > 3000) store.data.events.length = 3000;
    store.touch([pid]);
    const after = E.summarize(P, ST);
    ev.delayBefore = before.delay; ev.delayAfter = after.delay; ev.fcAfter = E.fmtFull(after.fc);
    ctx.broadcast('data', { version: store.data.version, origin: null, pids: [pid] });
    const label = { start: '开工', progress: '进度 ' + ev.p + '%', done: '完工', issue: '异常 · ' + ev.cause, resolve: '异常解除' }[action];
    ctx.broadcast('notice', { kind: action === 'issue' ? 'warn' : 'ok', text: '现场报工:' + P.code + ' ' + t.name + ' ' + label + (ev.who ? '(' + ev.who + ')' : '') + (after.delay !== before.delay ? ' · 预测交付 ' + (after.delay > before.delay ? '推迟' : '提前') + ' ' + Math.abs(after.delay - before.delay) + ' 天' : ''), ev });
    for (const fn of ctx.onReport) { try { await fn(ev, { P, ST, before, after }); } catch (e) { console.error('[onReport]', e); } }
    json(res, Object.assign({ ok: true, msg: r.msg, event: ev }, view(pid)));
  });

  route('GET', '/api/log', (req, res) => {
    const pid = req.query.get('pid'), n = Math.min(500, +req.query.get('limit') || 50);
    json(res, { ok: true, events: store.data.events.filter(e => !pid || e.pid === pid).slice(0, n) });
  });
};
