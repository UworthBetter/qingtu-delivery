/* 阶段 4:导入 / 导出生产进度计划表 */
'use strict';
const fs = require('fs');
const path = require('path');
const X = require('../lib/xlsx.js');
module.exports = async ({ srv, api, check }) => {
  console.log('导入 / 导出计划表');
  const samples = path.join(__dirname, '..', 'samples');
  const xbuf = fs.readFileSync(path.join(samples, '30吨AGV生产进度计划表.xlsx'));
  let r = await api(srv.base, 'POST', '/api/import/parse', { kind: 'xlsx', filename: '30吨AGV生产进度计划表.xlsx', data: xbuf.toString('base64') });
  const d = r.body;
  check(d.ok && d.tasks.length === 13 && d.name === '30吨AGV', 'xlsx 识别 ' + (d.tasks || []).length + ' 道工序,项目名「' + d.name + '」');
  const T = n => d.tasks.find(t => t.name === n);
  check(T('焊接').dept === '生产部' && T('喷漆').dept === '生产部', '合并的责任部门单元格已展开');
  check(T('机械设计').start === '2026-11-04' && T('机械设计').plan === 12, 'Excel 日期单元格 / 流程周期识别');
  check(T('装配').deps.length === 2 && T('试验').deps[0] === T('调试').id, '前置关系推断(并行采购汇合、插入的「调试」)');
  r = await api(srv.base, 'POST', '/api/import/commit', { draft: Object.assign({}, d, { code: 'HD-2699', customer: '测试客户' }), inferStatus: true });
  check(r.body.ok && r.body.pid, '创建项目 ' + r.body.pid);
  const pid = r.body.pid, data = (await api(srv.base, 'GET', '/api/data')).body;
  const st = data.projects[pid].tasks;
  check(st.create.s === 'done' && st.mdesign.s === 'active' && st.weld.s === 'pending', '按表中日期推断工序状态(截至 11-09)');
  const csv = fs.readFileSync(path.join(samples, 'KBK轻轨生产计划.csv'));
  r = await api(srv.base, 'POST', '/api/import/parse', { kind: 'csv', filename: 'KBK轻轨生产计划.csv', data: csv.toString('base64') });
  check(r.body.ok && r.body.tasks.length === 9 && r.body.tasks[3].owner === '下料班组', 'CSV 识别(含负责人列)');
  /* 导出 */
  const ex = await fetch(srv.base + '/api/export/' + pid + '.xlsx');
  const buf = Buffer.from(await ex.arrayBuffer());
  check(ex.ok && /attachment/.test(ex.headers.get('content-disposition')), '导出 Excel 文件');
  const back = X.read(buf).sheets[0].rows;
  check(back[0][0] === '30吨AGV生产进度计划表(生产指令)' && back[1][1] === '制作流程' && back[1][2] === '责任部门', '导出表头与参考格式一致');
  r = await api(srv.base, 'POST', '/api/import/parse', { kind: 'xlsx', filename: 'x.xlsx', data: buf.toString('base64') });
  check(r.body.ok && r.body.tasks.length === 13 && r.body.name === '30吨AGV', '导出的表格可再次导入(往返一致)');
  const ec = await fetch(srv.base + '/api/export/' + pid + '.csv');
  check(ec.ok && (await ec.text()).includes('制作流程'), '导出 CSV');
  r = await api(srv.base, 'POST', '/api/import/parse', { kind: 'feishu', url: 'https://x.feishu.cn/sheets/abc' });
  check(r.status === 400 && /FEISHU_APP_ID/.test(r.body.error), '未配置飞书应用时给出明确提示');
  r = await api(srv.base, 'POST', '/api/import/parse', { kind: 'xlsx', filename: 'a.xls', data: Buffer.from('not a zip').toString('base64') });
  check(r.status === 400, '非 xlsx 文件给出错误');
  const sm = await fetch(srv.base + '/api/samples/' + encodeURIComponent('30吨AGV生产进度计划表.xlsx'));
  check(sm.ok, '示例表格可下载');
  /* 写给其他测试:导出文件留给人工检查 */
  if (process.env.SHOT_DIR) fs.writeFileSync(path.join(process.env.SHOT_DIR, 'export.xlsx'), buf);
};
