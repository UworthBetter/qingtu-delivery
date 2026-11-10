/* 阶段 3:延期责任账页面、项目责任卡、飞书消息预览 */
'use strict';
const path = require('path');
module.exports = async ({ br, srv, open, sleep, check, SHOT }) => {
  console.log('延期责任账 / 飞书消息页面');
  await fetch(srv.base + '/api/reset', { method: 'POST' });
  const p = await open(br, srv.base + '/#ledger');
  await p.bringToFront(); await sleep(800);
  check(!(await p.$eval('#ck-ledger', e => e.hidden)), '#ledger 深链接打开责任账页面');
  check((await p.$$('#ck-lg-rank tbody tr')).length >= 3, '部门准时率表格');
  check((await p.$$('#ck-lg-proj .ck-lp-row')).length >= 1, '项目延期拆解列表');
  if (SHOT) await p.screenshot({ path: path.join(SHOT, 'ledger.png'), fullPage: true });
  await p.click('#ck-lg-proj .ck-lp-row'); await sleep(500);
  check(await p.$eval('#ck-lgd', e => /延期责任账/.test(e.innerText) && /晚/.test(e.innerText)), '项目详情显示延期责任卡');
  check(await p.$eval('#ck-back', e => e.textContent.includes('责任账')), '可返回责任账');
  await p.click('#ck-fs-btn'); await sleep(300);
  await p.click('#ck-fs-send'); await sleep(1200);
  check((await p.$$('#ck-fs-list .ck-fs-msg')).length >= 1, '飞书消息预览显示早报卡片');
  if (SHOT) await p.screenshot({ path: path.join(SHOT, 'feishu.png') });
  check(p.errors.length === 0, '无 JS 错误 ' + p.errors.join(' | '));
  await p.close();
};
