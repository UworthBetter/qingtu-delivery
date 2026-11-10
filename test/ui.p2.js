/* 阶段 2:手机报工页 + 码牌 + 大屏实时更新 */
'use strict';
const path = require('path');
module.exports = async ({ br, srv, open, sleep, check, SHOT }) => {
  console.log('扫码报工页面');
  await fetch(srv.base + '/api/reset', { method: 'POST' });
  const d = await (await fetch(srv.base + '/api/data')).json();
  const P = d.defs.find(P => P.tasks.some(t => d.projects[P.id].tasks[t.id].s === 'active'));
  const t = P.tasks.find(t => d.projects[P.id].tasks[t.id].s === 'active');
  const desk = await open(br, srv.base + '/');
  const m = await open(br, srv.base + '/r/' + P.id + '/' + t.id, { viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  check(m.errors.length === 0, '手机页无 JS 错误 ' + m.errors.join(' | '));
  check(await m.evaluate(n => document.querySelector('h1').textContent.includes(n), t.name), '显示工序名称');
  const noScroll = await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check(noScroll, '手机宽度无横向滚动');
  if (SHOT) await m.screenshot({ path: path.join(SHOT, 'mobile-step.png'), fullPage: true });
  /* 异常上报 */
  await m.click('[data-a="issue"]');
  await m.click('[data-c="缺料"]');
  await m.click('[data-d="1"]'); await m.click('[data-d="1"]');
  await m.type('#is-note', '电机未到货');
  if (SHOT) await m.screenshot({ path: path.join(SHOT, 'mobile-issue.png') });
  await m.click('#is-ok');
  await sleep(600);
  check(await m.evaluate(() => document.body.innerText.includes('已上报异常')), '异常上报成功页');
  if (SHOT) await m.screenshot({ path: path.join(SHOT, 'mobile-result.png') });
  await sleep(1200);
  check(await desk.evaluate(() => document.body.innerText.includes('现场报工')), '电脑端弹出实时报工提示');
  const st = await desk.evaluate((pid, tid) => window.__ck.state().projects[pid].tasks[tid].blk, P.id, t.id);
  check(st && st.cause === '缺料', '电脑端数据实时更新(异常标记)');
  /* 项目总码页 */
  const list = await open(br, srv.base + '/r/' + P.id, { viewport: { width: 390, height: 844, isMobile: true } });
  const href = await list.$eval('.steps a', a => a.href);
  check(href.endsWith('/r/' + P.id + '/' + P.tasks[0].id), '项目总码列出工序链接');
  /* 码牌 */
  console.log('    · 打开项目详情');
  await desk.bringToFront();
  await desk.evaluate(pid => { window.__ck.open(pid); }, P.id);
  await sleep(300);
  await desk.click('#ck-qr-btn'); await sleep(200);
  const n = await desk.$$eval('#ck-qr-grid .ck-qr-card svg', x => x.length);
  check(n >= 10, '生成码牌 ' + n + ' 张');
  if (SHOT) await desk.screenshot({ path: path.join(SHOT, 'qr-sheet.png') });
  await desk.click('#ck-qr-close');
  check(await desk.evaluate(() => document.querySelectorAll('#ck-feed-list .ck-fe').length) >= 1, '项目详情显示现场动态');
  check(desk.errors.length === 0, '电脑端无 JS 错误 ' + desk.errors.join(' | '));
  await m.close(); await list.close(); await desk.close();
};
