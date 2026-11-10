/* 阶段 2:扫码报工 API */
'use strict';
module.exports = async ({ srv, api, check }) => {
  console.log('扫码报工 API');
  await api(srv.base, 'POST', '/api/reset');
  const d = (await api(srv.base, 'GET', '/api/data')).body;
  /* 找一个「前置进行中、本工序未开工」的工序 */
  let pid, tid, pred;
  for (const P of d.defs) {
    const ST = d.projects[P.id].tasks;
    const t = P.tasks.find(t => ST[t.id].s === 'pending' && t.deps.length === 1 && ST[t.deps[0]].s === 'active');
    if (t) { pid = P.id; tid = t.id; pred = t.deps[0]; break; }
  }
  check(!!pid, '找到测试工序 ' + pid + '/' + tid);
  const page = await fetch(srv.base + '/r/' + pid + '/' + tid);
  check(page.ok && (await page.text()).includes('扫码报工'), '手机报工页可访问 /r/<项目>/<工序>');
  const v = await api(srv.base, 'GET', '/api/r/' + pid);
  check(v.body.ok && v.body.tasks.length > 5, '手机页数据接口');
  let r = await api(srv.base, 'POST', '/api/report', { pid, tid, action: 'start' });
  check(r.body.code === 'need_confirm', '前置未完工时开工需确认');
  r = await api(srv.base, 'POST', '/api/report', { pid, tid, action: 'start', force: true, who: '张师傅' });
  const T = id => r.body.tasks.find(t => t.id === id);
  check(r.body.ok && T(tid).s === 'active', '确认后开工');
  check(T(pred).s === 'done' && T(pred).cf && T(pred).by === 'downstream', '下游开工确认前置完工');
  r = await api(srv.base, 'POST', '/api/report', { pid, tid, action: 'progress', p: 40 });
  check(r.body.ok && T(tid).p === 40, '报进度 40%');
  const before = r.body.summary.delay;
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  r = await api(srv.base, 'POST', '/api/report', { pid, tid, action: 'issue', cause: '缺料', days: 5, note: '钢板未到', photo: png });
  check(r.body.ok && T(tid).blk && T(tid).blk.cause === '缺料', '异常上报(缺料)');
  check(r.body.summary.delay >= before, '异常耽误天数计入预测 ' + before + ' → ' + r.body.summary.delay);
  check(r.body.event.photo && (await fetch(srv.base + '/' + r.body.event.photo)).ok, '现场照片已保存可访问');
  r = await api(srv.base, 'POST', '/api/report', { pid, tid, action: 'resolve' });
  check(r.body.ok && !T(tid).blk, '解除异常');
  r = await api(srv.base, 'POST', '/api/report', { pid, tid, action: 'done' });
  check(r.body.ok && T(tid).s === 'done' && T(tid).cf === false, '完工后待下道工序确认');
  const log = await api(srv.base, 'GET', '/api/log?pid=' + pid);
  const mine = log.body.events.filter(e => e.tid === tid);
  check(mine.length === 5 && mine[0].action === 'done', '本工序报工记录 ' + mine.length + ' 条');
  const bad = await api(srv.base, 'POST', '/api/report', { pid, tid: 'nope', action: 'start' });
  check(bad.status === 400, '无效工序返回 400');
};
