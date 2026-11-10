/* 阶段 3:延期责任账 + 老板早报 + 飞书预警(演示模式) */
'use strict';
const crypto = require('crypto');
module.exports = async ({ srv, api, check }) => {
  console.log('延期责任账 / 老板早报 / 飞书');
  await api(srv.base, 'POST', '/api/reset');
  const ins = (await api(srv.base, 'GET', '/api/insight?month=2026-10')).body;
  check(ins.ok && ins.month === '2026-10' && ins.ranking.length >= 3, '部门准时率排行 ' + ins.ranking.map(r => r.dept + r.rate + '%').join(' '));
  const late = ins.projects.filter(p => !p.done && p.delay > 0);
  check(late.length >= 1 && /晚 \d+ 天/.test(late[0].text) && /责任部门/.test(late[0].text), '延期解释:' + (late[0] && late[0].text));
  check(Object.keys(ins.deptDays).length > 0, '延误天数按部门归属');
  const pv = (await api(srv.base, 'GET', '/api/brief')).body;
  check(pv.ok && pv.card.header.title.content.startsWith('老板早报') && pv.facts.top.length >= 1, '早报预览:' + pv.facts.top.map(t => t.code).join('、'));
  const all = JSON.stringify(pv.card);
  check(/找谁/.test(all) && /建议/.test(all), '早报包含责任人与建议动作');
  const s = (await api(srv.base, 'POST', '/api/brief/send')).body;
  check(s.ok && s.msg.status === 'demo' && s.msg.kind === 'brief', '未配置机器人时为演示模式(进入预览)');
  /* 异常上报 → 飞书异常推送;若首次延期 → 延期预警 */
  const d = (await api(srv.base, 'GET', '/api/data')).body;
  const P = d.defs.find(P => { const ST = d.projects[P.id].tasks; const c = ins.projects.find(x => x.pid === P.id); return c && !c.done && c.delay <= 0 && P.tasks.some(t => ST[t.id].s === 'active'); });
  const t = P.tasks.find(t => d.projects[P.id].tasks[t.id].s === 'active');
  await api(srv.base, 'POST', '/api/report', { pid: P.id, tid: t.id, action: 'issue', cause: '缺料', days: 15, note: '减速电机未到' });
  const ob = (await api(srv.base, 'GET', '/api/outbox')).body.messages;
  check(ob.some(m => m.kind === 'issue' && m.meta.pid === P.id), '异常上报推送飞书');
  check(ob.some(m => m.kind === 'late' && m.meta.pid === P.id), '预测交付首次晚于计划 → 延期预警');
  const ins2 = (await api(srv.base, 'GET', '/api/insight')).body.projects.find(x => x.pid === P.id);
  check(ins2.items.some(it => it.causes['缺料'] > 0), '责任账按上报原因归因(缺料)');
  /* 机器人签名:以「timestamp\n密钥」为 key 对空串做 HmacSHA256 */
  const f = require('../lib/feishu.js')({ env: {}, store: { data: { outbox: [] }, save() {} }, broadcast() {} });
  const sig = f.sign('1599360473', 'secret');
  check(sig === crypto.createHmac('sha256', '1599360473\nsecret').update('').digest('base64'), '机器人签名算法');
};
