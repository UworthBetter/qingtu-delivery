/* 延期责任账 + 老板早报 + 飞书预警
   - /api/insight:各项目延期拆解(按部门 / 原因)与月度部门准时率
   - 老板早报:每天 BRIEF_TIME(默认 08:00)推送到飞书群,也可手动「立即发送」
   - 预警:项目预测交付首次晚于计划时推送;现场异常上报时推送 */
'use strict';
const llm = require('./llm.js');

module.exports = function (ctx) {
  const { E, store, route, json, readJson } = ctx;
  const feishu = require('./feishu.js')(ctx);
  const md = d => E.md(d);

  /* ---------- 计算 ---------- */
  function all() {
    return store.data.defs.map(P0 => {
      const x = store.compute(P0.id);
      const evs = store.data.events.filter(e => e.pid === P0.id);
      const s = E.summarize(x.P, x.ST, x.c);
      return Object.assign(x, { s, evs, L: E.ledger(x.P, x.ST, x.c, evs) });
    });
  }
  function projectRow(x) {
    const { P, s, L } = x;
    return { pid: P.id, code: P.code, name: P.name, customer: P.customer, pm: P.pm, type: P.type, done: s.allDone, stage: s.stage,
      delay: L.delay, plan: E.fmtFull(L.plan), fc: E.fmtFull(L.fc), text: L.text, items: L.items, byDept: L.byDept, saved: L.saved,
      blocked: s.blocked.map(id => { const t = P.tasks.find(y => y.id === id); return { id, name: t.name, cause: x.ST[id].blk.cause }; }) };
  }
  function insight(month) {
    const list = all(), today = ctx.today();
    const ym = /^\d{4}-\d{2}$/.test(month || '') ? month : E.fmtFull(today).slice(0, 7);
    const months = [];
    for (let i = 0; i < 6; i++) months.push(E.fmtFull(new Date(today.getFullYear(), today.getMonth() - i, 1)).slice(0, 7));
    /* 部门责任天数汇总(在制项目 + 当月交付项目) */
    const deptDays = {};
    list.forEach(x => { if (x.s.allDone && E.fmtFull(x.L.fc).slice(0, 7) !== ym) return; Object.keys(x.L.byDept).forEach(k => { deptDays[k] = (deptDays[k] || 0) + x.L.byDept[k]; }); });
    const causeDays = {};
    list.forEach(x => { if (x.s.allDone) return; x.L.items.forEach(it => Object.keys(it.causes).forEach(k => { causeDays[k] = (causeDays[k] || 0) + it.causes[k]; })); });
    return { ok: true, month: ym, months, today: E.fmtFull(today), ranking: E.deptRanking(list, ym), deptDays, causeDays,
      projects: list.map(projectRow).sort((a, b) => (a.done - b.done) || (b.delay - a.delay)) };
  }
  ctx.insight = insight;
  route('GET', '/api/insight', (req, res) => json(res, insight(req.query.get('month'))));

  /* ---------- 建议动作 ---------- */
  const ACTION = {
    '缺料': (it, buy) => '今天请' + (buy ? buy.dept + (buy.owner ? buy.owner : '') : '采购部') + '和供应商确认到货日期,必要时调拨库存或加急发运;到料后' + it.owner + '安排加班,把' + it.name + '耽误的天数追回来',
    '外购件未到': (it, buy) => '今天请' + (buy ? buy.dept + (buy.owner ? buy.owner : '') : '采购部') + '催供应商,确认外购件到货日期;同时检查能否先做不依赖该件的装配',
    '图纸问题': it => '请技术部今天出设计变更 / 澄清单,当天下发到' + it.name + '工序',
    '返工': it => '质检牵头复盘返工原因,' + it.dept + '安排加班把耽误的天数追回来',
    '设备': it => '设备维修今天抢修,超过 1 天考虑外协加工',
    '等上工序 / 排队': it => '调整' + it.name + '的排产优先级,或安排加班 / 外协消化排队',
    '其他': it => '请' + (it.owner || it.dept) + '今天给出追赶计划和新的完工日期',
    '未登记原因': it => '请' + (it.owner || it.dept) + '今天说明原因,给出追赶计划和新的完工日期'
  };
  function topCause(it) { const k = Object.keys(it.causes).sort((a, b) => it.causes[b] - it.causes[a]); return k[0] || '未登记原因'; }
  function riskList() {
    return all().filter(x => !x.s.allDone).map(x => {
      const open = x.L.items.filter(it => it.blk && it.s !== 'done');
      const blkIds = x.s.blocked;
      const score = Math.max(0, x.L.delay) * 10 + blkIds.length * 8 + (x.L.delay > 0 && x.L.delay >= 5 ? 5 : 0);
      /* 责任人:未解除异常的工序优先,否则延误最多的关键链工序 */
      let key = null;
      if (blkIds.length) { const t = x.P.tasks.find(y => y.id === blkIds[0]); key = x.L.items.find(it => it.id === t.id) || { id: t.id, name: t.name, dept: E.deptOf(t), owner: t.owner || t.role || '', own: 0, wait: 0, causes: { [x.ST[t.id].blk.cause]: x.ST[t.id].blk.days || 0 }, blk: x.ST[t.id].blk }; }
      else key = x.L.items.slice().sort((a, b) => (Math.max(0, b.own) + b.wait) - (Math.max(0, a.own) + a.wait))[0] || null;
      const cause = key ? (key.blk ? key.blk.cause : topCause(key)) : null;
      /* 缺料类问题找采购:电气类工序找电气采购,其余找工艺采购 */
      let buy = null;
      if (cause === '缺料' || cause === '外购件未到') {
        const bid = /edesign|epurchase|assemble/.test(key.id) && cause === '外购件未到' ? 'epurchase' : 'mpurchase', bt = x.P.tasks.find(y => y.id === bid);
        if (bt) buy = { dept: E.deptOf(bt), owner: bt.owner || bt.role || '' };
      }
      let action = key ? (ACTION[cause] || ACTION['其他'])(key, buy) : '保持关注';
      if (x.L.delay >= 5) action += ';同时由项目经理' + (x.P.pm || '') + '提前与客户沟通交期';
      const who = buy ? buy.dept + (buy.owner ? ' · ' + buy.owner : '') + '(到料)、' + key.dept + (key.owner ? ' · ' + key.owner : '') + '(追进度)' : (key ? key.dept + (key.owner ? ' · ' + key.owner : '') : '');
      return { x, score, key, cause, action, who };
    }).filter(r => r.score > 0).sort((a, b) => b.score - a.score);
  }

  /* ---------- 老板早报 ---------- */
  function briefFacts() {
    const list = all(), live = list.filter(x => !x.s.allDone), today = ctx.today();
    const risks = riskList();
    const since = Date.now() - 24 * 3600 * 1000, evs = store.data.events.filter(e => e.ts >= since);
    const ym = E.fmtFull(today).slice(0, 7), rk = E.deptRanking(list, ym).filter(r => r.n >= 2);
    return {
      date: md(today), live: live.length, late: live.filter(x => x.L.delay > 0).length,
      blocked: live.reduce((a, x) => a + x.s.blocked.length, 0), reports: evs.length, issues: evs.filter(e => e.action === 'issue').length,
      top: risks.slice(0, 3).map(r => ({ code: r.x.P.code, name: r.x.P.name, customer: r.x.P.customer, pm: r.x.P.pm, delay: r.x.L.delay, fc: md(r.x.L.fc), plan: md(r.x.L.plan),
        why: r.x.L.text, step: r.key && r.key.name, dept: r.key && r.key.dept, owner: r.key && r.key.owner, who: r.who, cause: r.cause, action: r.action, pid: r.x.P.id })),
      worstDept: rk.length ? rk[rk.length - 1] : null, bestDept: rk.length ? rk[0] : null
    };
  }
  function briefTemplate(f) {
    const blocks = [];
    blocks.push('**在制 ' + f.live + ' 个项目,' + (f.late ? '<font color="red">' + f.late + ' 个预计延期</font>' : '全部预计按期') + (f.blocked ? ',' + f.blocked + ' 个工序有未解除异常' : '') + '。**\n近 24 小时现场报工 ' + f.reports + ' 次' + (f.issues ? ',新上报异常 ' + f.issues + ' 个' : '') + '。');
    if (!f.top.length) blocks.push('今天没有需要您处理的风险项目。');
    f.top.forEach((r, i) => {
      blocks.push('**' + (i + 1) + '. ' + r.code + ' ' + r.name + '**(' + r.customer + ')\n'
        + (r.delay > 0 ? '<font color="red">预计晚 ' + r.delay + ' 天交付</font>(' + r.fc + ',计划 ' + r.plan + ')' : '预计 ' + r.fc + ' 交付,但有异常未解除') + '\n'
        + '原因:' + r.why.replace(/^.*?因/, '').replace(/。$/, '') + '\n'
        + '找谁:' + (r.who || '') + '\n'
        + '建议:' + r.action);
    });
    if (f.worstDept && f.bestDept && f.worstDept.dept !== f.bestDept.dept) blocks.push('本月部门准时率:' + f.bestDept.dept + ' ' + f.bestDept.rate + '% 最高,' + f.worstDept.dept + ' ' + f.worstDept.rate + '% 最低(超期 ' + f.worstDept.late + ' 道工序,共 ' + f.worstDept.lateDays + ' 天)。');
    return blocks;
  }
  async function briefCard(useLlm, base) {
    const f = briefFacts();
    let blocks = briefTemplate(f), by = 'template';
    if (useLlm && llm.ready()) {
      const text = await llm.complete(
        '你是一家非标搬运装备制造厂(起重机、AGV、电动平车)的生产助理,每天早上给老板写一条飞书早报。'
        + '只能使用用户提供的事实和数字,不得编造任何项目、日期、人名或原因。用简体中文,语气干练,像经验丰富的生产经理向老板汇报。'
        + '输出飞书 lark_md 格式:可用 **加粗**、<font color="red">红字</font>、换行;不要标题、不要表格、不要代码块。'
        + '结构:第一段一句话总体情况;然后最多 3 个风险项目,每个包含:项目、晚几天、根本原因、找谁、今天该做的具体动作;最后一句部门准时率提醒(若有)。总长度不超过 450 字。',
        '今天的事实(JSON):\n' + JSON.stringify(f) + '\n\n参考模板写法(可改进措辞,但事实必须一致):\n' + blocks.join('\n\n'),
        { maxTokens: 4000, effort: 'medium' });
      if (text) { blocks = text.split(/\n{2,}/); by = 'llm'; }
    }
    const card = feishu.card('老板早报 · ' + f.date, f.late ? 'orange' : 'green', blocks,
      [{ text: '打开交付管家', url: base + '/' }, { text: '查看延期责任账', url: base + '/#ledger' }],
      '擎图 · 交付管家 · 数据截至 ' + f.date + (by === 'llm' ? ' · AI 撰写' : ''));
    return { card, facts: f, by };
  }
  async function sendBrief(reason, base) {
    const b = await briefCard(true, base || ctx.baseUrl(null));
    const msg = await feishu.send('brief', b.card, { reason, by: b.by });
    return msg;
  }
  route('GET', '/api/brief', async (req, res) => { const b = await briefCard(false, ctx.baseUrl(req)); json(res, Object.assign({ ok: true }, b)); });
  route('POST', '/api/brief/send', async (req, res) => { const msg = await sendBrief('manual', ctx.baseUrl(req)); json(res, { ok: true, msg }); });
  route('GET', '/api/outbox', (req, res) => json(res, { ok: true, features: ctx.features(), briefTime: briefTime(), messages: store.data.outbox.slice(0, 60) }));
  route('POST', '/api/outbox/clear', (req, res) => { store.data.outbox = []; store.save(); ctx.broadcast('outbox', { cleared: true }); json(res, { ok: true }); });

  /* ---------- 定时早报 ---------- */
  function briefTime() { const v = process.env.BRIEF_TIME; return v === undefined ? '08:00' : v; }
  function tick() {
    const bt = briefTime(); if (!/^\d{1,2}:\d{2}$/.test(bt)) return;
    const now = new Date(), [h, m] = bt.split(':').map(Number), dayKey = now.toISOString().slice(0, 10);
    if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return;
    if (store.data.flags.briefDay === dayKey) return;
    store.data.flags.briefDay = dayKey; store.save();
    sendBrief('schedule').catch(e => console.error('[brief]', e));
  }
  (ctx.onListen = ctx.onListen || []).push(() => { setInterval(tick, 30000).unref(); setTimeout(tick, 3000).unref(); });

  /* ---------- 延期预警:预测交付首次晚于计划 ---------- */
  function lateMap() { const m = {}; all().forEach(x => { if (!x.s.allDone) m[x.P.id] = x.L.delay; }); return m; }
  (ctx.afterLoad = ctx.afterLoad || []).push(() => { store.data.flags.late = lateMap(); });
  store.hooks.push(pids => {
    const prev = store.data.flags.late || {}, cur = lateMap();
    store.data.flags.late = cur;
    if (!pids.length) return;   /* 重置演示:只记录,不推送 */
    pids.forEach(pid => {
      const d = cur[pid]; if (d == null || d <= 0 || (prev[pid] != null && prev[pid] > 0)) return;
      const r = riskList().find(r => r.x.P.id === pid), P = store.def(pid), base = ctx.baseUrl(null);
      const x = r ? r.x : store.compute(pid), L = r ? r.x.L : E.ledger(x.P, x.ST, x.c);
      feishu.send('late', feishu.card('延期预警 · ' + P.code + ' ' + P.name, 'red',
        ['**预计交付 ' + md(L.fc) + ',晚于计划 ' + md(L.plan) + ' 共 <font color="red">' + d + ' 天</font>。**', L.text.replace(/^.*?因/, '原因:'),
          r && r.key ? '找谁:' + r.who + '\n建议:' + r.action : ''].filter(Boolean),
        [{ text: '查看项目', url: base + '/#p=' + pid }], '客户:' + P.customer + ' · 项目经理:' + (P.pm || '—')), { pid });
    });
  });

  /* ---------- 现场异常推送 ---------- */
  (ctx.onReport = ctx.onReport || []).push(async (ev, info) => {
    if (ev.action !== 'issue') return;
    const P = info.P, base = ctx.baseUrl(null), t = P.tasks.find(y => y.id === ev.tid);
    const dd = info.after.delay - info.before.delay;
    await feishu.send('issue', feishu.card('现场异常 · ' + P.code + ' ' + ev.step + ' · ' + ev.cause, 'orange',
      ['**' + P.name + '**(' + P.customer + ')\n' + ev.step + '(' + ev.dept + (t && t.owner ? ' · ' + t.owner : '') + ')上报:**' + ev.cause + '**' + (ev.days ? ',预计耽误 ' + ev.days + ' 天' : '') + (ev.who ? '\n上报人:' + ev.who : ''),
        ev.note ? '说明:' + ev.note : '',
        '项目预测交付 ' + ev.fcAfter.slice(5).replace('-', '月') + '日' + (dd > 0 ? ',<font color="red">因此推迟 ' + dd + ' 天</font>' : (info.after.delay > 0 ? '(已晚于计划 ' + info.after.delay + ' 天)' : '(仍在计划内)'))].filter(Boolean),
      [{ text: '查看现场', url: base + '/r/' + P.id + '/' + ev.tid }].concat(ev.photo ? [{ text: '查看照片', url: base + '/' + ev.photo }] : []),
      '擎图 · 扫码报工'), { pid: P.id, tid: ev.tid });
  });
};
