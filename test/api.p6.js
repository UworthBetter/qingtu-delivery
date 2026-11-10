/* 阶段 6:外购件影响预测 + 客户进度链接 */
'use strict';
module.exports = async ({ srv, api, check }) => {
  console.log('外购件 / 客户链接 API');
  await api(srv.base, 'POST', '/api/reset');
  let d = (await api(srv.base, 'GET', '/api/data')).body;
  const P = d.defs.find(P => (P.parts || []).length && d.projects[P.id].tasks.assemble.s === 'pending');
  check(!!P, '演示项目带关键外购件 ' + (P && P.code));
  const ins0 = (await api(srv.base, 'GET', '/api/insight')).body.projects.find(x => x.pid === P.id);
  /* 把一个外购件的预计到货推迟到很晚 → 预测交付推迟,责任账记为「外购件未到」 */
  const def = JSON.parse(JSON.stringify(P));
  def.parts[1].arrived = null; def.parts[1].eta = '2027-06-01';
  def.share = { token: 'abcdef0123456789ab', on: true, show: { dates: true, steps: true, updates: true, photos: false, delay: true } };
  let r = await api(srv.base, 'PUT', '/api/projects', { upsert: { [P.id]: { def, state: d.projects[P.id] } }, revs: { [P.id]: d.rev[P.id] } });
  check(r.body.ok, '保存外购件修改');
  const ins1 = (await api(srv.base, 'GET', '/api/insight')).body.projects.find(x => x.pid === P.id);
  check(ins1.delay > ins0.delay && ins1.items.some(it => it.causes['外购件未到'] > 0), '外购件晚到推迟预测并计入责任账(' + ins0.delay + ' → ' + ins1.delay + ' 天)');
  const c = (await api(srv.base, 'GET', '/api/c/abcdef0123456789ab')).body;
  check(c.ok && c.milestones.length >= 5 && c.fc && c.delay && c.delay.reasons.includes('外购件到货延迟'), '客户链接:里程碑、预计交付、友好的延期原因 ' + JSON.stringify(c.delay));
  const raw = JSON.stringify(c);
  check(!/部门|班组|采购员|owner|dept/.test(raw), '客户链接不泄露内部部门 / 负责人');
  const page = await fetch(srv.base + '/c/abcdef0123456789ab');
  check(page.ok, '客户页面可访问');
  def.share.on = false; d = (await api(srv.base, 'GET', '/api/data')).body;
  await api(srv.base, 'PUT', '/api/projects', { upsert: { [P.id]: { def, state: d.projects[P.id] } }, revs: { [P.id]: d.rev[P.id] } });
  r = await api(srv.base, 'GET', '/api/c/abcdef0123456789ab');
  check(r.status === 404, '关闭后链接失效');
};
