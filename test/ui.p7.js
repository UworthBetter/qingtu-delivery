/* 宽表导入:多项目预览 + 批量确认 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const X = require('../lib/xlsx.js');
module.exports = async ({ br, srv, open, sleep, check, SHOT }) => {
  console.log('宽表导入页面');
  await fetch(srv.base + '/api/reset', { method: 'POST' });
  const csv = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qt-wide-')), '项目执行表.csv');
  fs.writeFileSync(csv, X.writeCsv(require('./fixtures/wide.js').rows()));
  const p = await open(br, srv.base + '/');
  await p.bringToFront();
  await p.evaluate(() => { document.querySelector('#ck-nav button[data-page="projects"]').click(); });
  await sleep(300);
  await p.click('#ck-import'); await sleep(200);
  await (await p.$('#ck-im-file')).uploadFile(csv);
  await sleep(1500);
  check((await p.$$('#ck-iw-tb tbody tr[data-i]')).length === 22, '预览 22 个项目');
  check(/将新建 22 个、更新 0 个、跳过 0 个/.test(await p.$eval('#ck-iw-sum', e => e.textContent)), '底部汇总:新建 22');
  await p.click('#ck-iw-tb [data-det="0"]'); await sleep(100);
  check(!(await p.$eval('#ck-iw-tb [data-detrow="0"]', e => e.hidden)) && /负责人/.test(await p.$eval('#ck-iw-tb [data-detrow="0"]', e => e.textContent)), '展开项目明细(工序 / 负责人 / 计划 / 实际 / 前置)');
  await p.select('#ck-iw-tb select[data-i="1"]', 'skip'); await sleep(100);
  check(/新建 21 个、更新 0 个、跳过 1 个/.test(await p.$eval('#ck-iw-sum', e => e.textContent)), '可把某个项目改为「跳过」');
  if (SHOT) await p.screenshot({ path: path.join(SHOT, 'import-wide.png') });
  await p.click('#ck-im-ok'); await sleep(1800);
  const data = await (await fetch(srv.base + '/api/data')).json();
  check(data.defs.filter(x => /^DEMO-/.test(x.code)).length === 21, '确认后创建 21 个项目(跳过 1 个)');
  /* 再导一次:已存在的默认「更新」 */
  await p.click('#ck-import'); await sleep(200);
  await (await p.$('#ck-im-file')).uploadFile(csv); await sleep(1500);
  check((await p.$$('#ck-iw-tb select[data-i] option[value="update"]:checked')).length === 21, '再次导入:21 个已存在的默认「更新已有项目」');
  check(p.errors.length === 0, '无 JS 错误 ' + p.errors.join(' | '));
  await p.close();
};
