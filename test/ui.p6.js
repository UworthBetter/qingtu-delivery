/* 阶段 6:外购件表格、齐套标记、客户链接对话框与客户页 */
'use strict';
const path = require('path');
module.exports = async ({ br, srv, open, sleep, check, SHOT }) => {
  console.log('外购件 / 客户链接页面');
  await fetch(srv.base + '/api/reset', { method: 'POST' });
  const d = await (await fetch(srv.base + '/api/data')).json();
  const P = d.defs.find(P => (P.parts || []).length && d.projects[P.id].tasks.assemble.s === 'pending');
  const p = await open(br, srv.base + '/#p=' + P.id);
  await p.bringToFront(); await sleep(500);
  check((await p.$$('#ck-parts tbody tr')).length === P.parts.length, '外购件表格 ' + P.parts.length + ' 行');
  check(await p.$eval('#ck-flow', e => /缺 \d 件|齐套/.test(e.innerText)), '流程节点显示齐套 / 缺件');
  const before = await p.evaluate(pid => window.__ck.compute(pid).projEnd, P.id);
  await p.$eval('#ck-parts tbody tr:nth-child(2) input[data-f="eta"]', e => { e.value = '2027-05-01'; e.dispatchEvent(new Event('change', { bubbles: true })); });
  await sleep(300);
  const after = await p.evaluate(pid => window.__ck.compute(pid).projEnd, P.id);
  check(after > before, '修改预计到货后预测交付更新(' + before + ' → ' + after + ')');
  if (SHOT) await p.screenshot({ path: path.join(SHOT, 'parts.png'), fullPage: true });
  await p.click('#ck-share-btn'); await sleep(200);
  await p.click('#ck-sh-on'); await sleep(1500);
  const url = await p.$eval('#ck-sh-body .u a', a => a.href);
  check(/\/c\/[0-9a-f]{18}$/.test(url), '生成客户链接');
  const c = await open(br, url.replace(/^http:\/\/[^/]+/, srv.base), { viewport: { width: 390, height: 844, isMobile: true } });
  await sleep(300);
  check(await c.evaluate(() => /预计交付/.test(document.body.innerText) && /生产制造/.test(document.body.innerText)), '客户页显示里程碑与预计交付');
  if (SHOT) await c.screenshot({ path: path.join(SHOT, 'customer.png'), fullPage: true });
  check(p.errors.length === 0 && c.errors.length === 0, '无 JS 错误 ' + p.errors.concat(c.errors).join(' | '));
  await c.close(); await p.close();
};
