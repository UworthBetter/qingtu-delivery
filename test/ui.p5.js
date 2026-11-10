/* 阶段 5:接单交期评估 */
'use strict';
const path = require('path');
module.exports = async ({ br, srv, open, sleep, check, SHOT }) => {
  console.log('接单交期评估');
  await fetch(srv.base + '/api/reset', { method: 'POST' });
  const p = await open(br, srv.base + '/');
  await p.bringToFront();
  await p.evaluate(() => document.querySelector('#ck-nav button[data-page="promise"]').click());
  await sleep(500);
  check(!(await p.$eval('#ck-promise', e => e.hidden)), '打开接单评估页');
  const big = await p.$eval('.ck-pm-big', e => e.textContent);
  check(/\d+月\d+日/.test(big), '给出最早可承诺日 ' + big);
  check(await p.$eval('#ck-pm-res', e => /瓶颈|没有产能瓶颈/.test(e.innerText)), '给出瓶颈判断');
  check((await p.$$('#ck-pm-steps tbody tr')).length === 15, '工序排程 15 行');
  check((await p.$$('#ck-pm-heat tbody tr')).length >= 10, '班组负荷热力图');
  await p.$eval('#ck-pm-want', e => { e.value = '2026-12-01'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(200);
  check(await p.$eval('#ck-pm-res', e => /来不及/.test(e.innerText)), '期望日过早时提示来不及');
  if (SHOT) await p.screenshot({ path: path.join(SHOT, 'promise.png'), fullPage: true });
  await p.click('#ck-pm-create'); await sleep(800);
  check(!(await p.$eval('#ck-detail', e => e.hidden)), '按排程创建项目并打开详情');
  check(p.errors.length === 0, '无 JS 错误 ' + p.errors.join(' | '));
  /* 单机模式同样可用 */
  const f = await open(br, 'file://' + path.join(__dirname, '..', 'index.html') + '?today=2026-11-09');
  await f.evaluate(() => document.querySelector('#ck-nav button[data-page="promise"]').click());
  await sleep(300);
  check(/\d+月\d+日/.test(await f.$eval('.ck-pm-big', e => e.textContent)) && f.errors.length === 0, '单机模式可评估 ' + f.errors.join(' | '));
  await f.evaluate(() => { localStorage.clear(); });
  await f.close(); await p.close();
};
