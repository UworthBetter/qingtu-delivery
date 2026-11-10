/* 阶段 4:导入对话框 + 导出按钮 */
'use strict';
const path = require('path');
module.exports = async ({ br, srv, open, sleep, check, SHOT }) => {
  console.log('导入计划表页面');
  await fetch(srv.base + '/api/reset', { method: 'POST' });
  const p = await open(br, srv.base + '/');
  await p.bringToFront();
  await p.evaluate(() => { document.querySelector('#ck-nav button[data-page="projects"]').click(); });
  await sleep(300);
  await p.click('#ck-import'); await sleep(200);
  const input = await p.$('#ck-im-file');
  await input.uploadFile(path.join(__dirname, '..', 'samples', '30吨AGV生产进度计划表.xlsx'));
  await sleep(1200);
  check((await p.$$('#ck-im-draft tbody tr')).length === 13, '预览 13 道工序');
  if (SHOT) await p.screenshot({ path: path.join(SHOT, 'import.png') });
  await p.$eval('#ck-imf-code', e => { e.value = 'HD-2631'; });
  await p.click('#ck-im-ok'); await sleep(1500);
  check(!(await p.$eval('#ck-detail', e => e.hidden)) && (await p.$eval('#ck-d-name', e => e.textContent)) === '30吨AGV', '创建后打开项目详情');
  await p.click('#ck-tab-gantt'); await sleep(300);
  check(!!(await p.$('#ck-gs-xlsx')), '甘特图有「导出 Excel」');
  await p.click('#ck-gs-feishu'); await sleep(200);
  check(!(await p.$eval('#ck-fx-ov', e => e.hidden)) && !!(await p.$('#ck-fx-url')) && /FEISHU_APP_ID/.test(await p.$eval('#ck-fx-hint', e => e.textContent)), '「写入飞书」对话框:可选目标表格链接 + 未配置提示');
  await p.click('#ck-fx-tabs [data-t="bitable"]');
  check((await p.$eval('#ck-fx-tabs [data-t="bitable"]', e => e.getAttribute('aria-pressed'))) === 'true', '可切换为多维表格');
  await p.click('#ck-fx-close');
  check(p.errors.length === 0, '无 JS 错误 ' + p.errors.join(' | '));
  await p.close();
};
