/* 宽表导入:一行一个项目(合成示例多维表格「项目执行表」22 条记录)+ 批量创建 / 更新 */
'use strict';
const X = require('../lib/xlsx.js');
const E = require('../engine.js');
const fx = require('./fixtures/wide.js');
module.exports = async ({ srv, api, check }) => {
  console.log('宽表导入(一行一个项目)');
  const rows = fx.rows();
  const csv = Buffer.from(X.writeCsv(rows), 'utf8').toString('base64');
  const before = (await api(srv.base, 'GET', '/api/data')).body.defs.length;
  let r = await api(srv.base, 'POST', '/api/import/parse', { kind: 'csv', filename: '项目执行表.csv', data: csv });
  const d = r.body, P = code => (d.projects || []).find(p => p.code === code), T = (p, n) => p.tasks.find(t => t.name === n);
  check(r.status === 200 && d.ok && d.wide === true && !d.tasks, '识别为宽表(没有「制作流程 / 工序」列)');
  check(d.projects.length === 22 && d.stages.join() === '设计,采购,生产,厂内调试,包装,发货,厂外调试', '生成 22 个项目,环节:' + d.stages.join('、'));
  /* 抽查:示例新能源30吨AGV */
  const a = P('DEMO-119-PJ');
  check(a.name === '示例新能源30吨AGV项目' && a.type === 'AGV小车类' && a.due === '2026-12-03' && /设备需求:30吨AGV/.test(a.note) && /销售工程师:汤博文/.test(a.note), '项目名称 / 合同编号 / 类别 / 合同交货期 / 备注');
  check(T(a, '设计').start === '2026-10-01' && T(a, '设计').planEnd === '2026-10-28' && T(a, '设计').actualEnd === '2026-10-24' && T(a, '设计').status.s === 'done' && T(a, '设计').plan === 28, '设计:开始 / 计划完成 / 实际完成 → 已完成,计划 28 天');
  check(T(a, '生产').owner === '郭子涵' && T(a, '生产').start === '2026-10-25' && T(a, '生产').planEnd === '2026-11-20' && T(a, '生产').status.s === 'active' && !T(a, '生产').late, '生产:负责人、计划起止、进行中');
  check(T(a, '包装').owner === '吴浩然' && T(a, '发货').planEnd === '2026-12-05' && T(a, '发货').status.s === 'pending', '包装负责人;发货计划 = 计划交付时间');
  check(T(a, '采购').planEnd === '2026-11-20' && !T(a, '采购').actualEnd && T(a, '采购').start === '2026-10-25' && T(a, '采购').deps.join() === 'mdesign', '采购:缺开始时间按设计结束次日推算(10-25)');
  check(!/年\s+月/.test(a.note) && !T(a, '设计').note.includes('年   月'), '进度记录里未填写的「年 月 日」模板行已去掉');
  /* 延期 */
  const b = P('DEMO-101-PJ-01');
  check(T(b, '生产').actualEnd === '2026-08-30' && T(b, '生产').planEnd === '2026-07-31' && T(b, '生产').status.s === 'done', '生产:实际完成晚于计划完成(完成但超期)');
  check(T(b, '发货').late && T(b, '发货').lateDays === 71 && T(b, '发货').status.s === 'pending', '计划交付已过、没有实际发货 → 标记延期 71 天');
  check(b.warnings.some(w => /晚于今天/.test(w)), '晚于今天的「实际完成」按未完成并提示');
  const c = P('DEMO-115-PJ');
  check(T(c, '生产').late && T(c, '生产').status.s === 'active' && T(c, '生产').lateDays === 15, '生产计划完成已过 15 天仍未完成 → 进行中 + 延期');
  const bad = P('DEMO-117-PJ');
  check(bad.warnings.some(w => /早于开始时间/.test(w)) && T(bad, '生产').start === '2026-10-15' && T(bad, '生产').planEnd === null, '计划完成早于开始时间:忽略该日期并提示(不编造)');
  /* 没有任何日期的项目:日期留空 */
  const e = P('DEMO-106-PJ-01');
  check(e && e.tasks.every(t => !t.actualEnd && t.status.s !== 'done') && !T(e, '设计').start && !T(e, '设计').planEnd && e.warnings.some(w => /标准估算/.test(w)), '没有计划日期的项目:日期留空,工期按标准估算并提示');
  check(d.projects.every(p => p.match === null && p.action === 'create'), '库里没有同名 / 同合同编号项目时默认「新建」');
  /* 批量创建 */
  r = await api(srv.base, 'POST', '/api/import/commit-batch', { projects: d.projects });
  check(r.body.ok && r.body.created.length === 22 && r.body.updated.length === 0, '批量创建 22 个项目');
  let data = (await api(srv.base, 'GET', '/api/data')).body;
  check(data.defs.length === before + 22, '项目总数 ' + before + ' → ' + data.defs.length);
  const pid = r.body.created.find(x => x.name === a.name).pid, def = data.defs.find(x => x.id === pid), st = data.projects[pid].tasks;
  check(def.code === 'DEMO-119-PJ' && def.due === '2026-12-03' && /销售工程师/.test(def.note) && def.tasks.find(t => t.id === 'make').owner === '郭子涵', '项目定义:合同编号 / 交货期 / 备注 / 工序负责人已保存');
  check(st.mdesign.s === 'done' && st.mdesign.d === 24 && st.make.s === 'active' && st.mpurchase.s === 'active' && st.ship.s === 'pending', '工序状态与实际工期(设计实际 10-01~10-24 = 24 天)');
  /* 引擎:延期要能算出来 */
  const calc = id => { const Pd = E.prep(E.cloneJ(data.defs.find(x => x.id === id)), E.today('2026-11-09')), S = data.projects[id].tasks; return E.summarize(Pd, S, E.computeFor(Pd, S)); };
  const lateId = r.body.created.find(x => x.name === '示例电力特高压70吨全向车项目').pid;
  check(calc(lateId).delay > 0, '延期项目(示例电力特高压 70 吨全向车)在引擎里预测延期 ' + calc(lateId).delay + ' 天');
  check(calc(pid).delay != null, '正常项目可计算预测交付');
  /* 再次导入:已存在 → 默认更新 */
  r = await api(srv.base, 'POST', '/api/import/parse', { kind: 'csv', filename: '项目执行表.csv', data: csv });
  check(r.body.projects.every(p => p.match && p.match.by === 'code' && p.action === 'update'), '再次导入:22 个都按合同编号匹配已有项目,默认「更新」');
  const again = r.body.projects.map(p => Object.assign({}, p));
  again[0].action = 'skip'; again[1].action = 'create'; again[1].code = ''; again[1].name = '另一个新项目';
  const n0 = (await api(srv.base, 'GET', '/api/data')).body.defs.length, rev0 = (await api(srv.base, 'GET', '/api/data')).body.rev;
  r = await api(srv.base, 'POST', '/api/import/commit-batch', { projects: again });
  data = (await api(srv.base, 'GET', '/api/data')).body;
  check(r.body.ok && r.body.updated.length === 20 && r.body.created.length === 1 && r.body.skipped.length === 1 && data.defs.length === n0 + 1, '更新 20 个、新建 1 个、跳过 1 个,不重复创建');
  check(data.rev[pid] === rev0[pid] + 1 && data.defs.filter(x => x.code === 'DEMO-119-PJ').length === 1, '更新保留项目 id 并递增版本号');
  /* 只有名称相同也算重复 */
  const noCode = Object.assign({}, again[5], { code: '' });
  const m = await api(srv.base, 'POST', '/api/import/parse', { kind: 'csv', filename: 'x.csv', data: Buffer.from(X.writeCsv(rows.map((row, i) => i && row[rows[0].indexOf('合同编号')] ? row.map((c, j) => j === rows[0].indexOf('合同编号') ? '' : c) : row)), 'utf8').toString('base64') });
  check(m.body.projects.every(p => p.match && p.match.by === 'name'), '没有合同编号时按项目名称匹配');
  r = await api(srv.base, 'POST', '/api/import/commit-batch', { projects: [] });
  check(r.status === 400, '空列表给出错误');
  /* 旧格式不受影响 */
  const old = await api(srv.base, 'POST', '/api/import/parse', { kind: 'csv', filename: 'k.csv', data: require('fs').readFileSync(require('path').join(__dirname, '..', 'samples', 'KBK轻轨生产计划.csv')).toString('base64') });
  check(old.body.ok && !old.body.wide && old.body.tasks.length === 9, '一行一工序的旧格式仍走原逻辑');
};
