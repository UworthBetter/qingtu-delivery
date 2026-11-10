/* 前端:无头 Chrome 检查 JS 错误、各页面渲染、多终端实时同步、单机模式 */
'use strict';
const path = require('path');
const fs = require('fs');
const { startServer, browser, open, sleep, check, done, ROOT } = require('./helpers');
const SHOT = process.env.SHOT_DIR || null;

(async () => {
  const srv = await startServer();
  const br = await browser();
  try {
    console.log('单机模式(file://)');
    const pf = await open(br, 'file://' + path.join(ROOT, 'index.html') + '?today=2026-11-09');
    check(pf.errors.length === 0, '无 JS 错误 ' + pf.errors.join(' | '));
    check(await pf.$eval('#ck-sync', e => e.dataset.st) === 'local', '显示「单机演示」');
    check((await pf.$$('.ck-pcard, .ck-ptable tbody tr')).length >= 10, '项目总览有演示项目');
    await pf.close();

    console.log('服务端模式');
    const a = await open(br, srv.base + '/');
    const b = await open(br, srv.base + '/');
    await sleep(500);
    check(a.errors.length === 0 && b.errors.length === 0, '无 JS 错误 ' + a.errors.concat(b.errors).join(' | '));
    check(await a.$eval('#ck-sync', e => e.dataset.st) === 'live', '显示「已同步」');
    /* 终端 A 修改项目名称 → 终端 B 实时更新 */
    await a.evaluate(() => { const d = window.__ck.defs(); d[0].name = '同步测试项目'; });
    await a.evaluate(() => { document.querySelector('#ck-nav button[data-page="production"]').click(); document.querySelector('#ck-nav button[data-page="projects"]').click(); });
    await sleep(2500);
    await b.bringToFront(); await sleep(500);
    check(await b.evaluate(() => document.body.innerText.includes('同步测试项目')), '终端 B 实时收到修改');
    /* 刷新后仍在 */
    const c = await open(br, srv.base + '/');
    check(await c.evaluate(() => document.body.innerText.includes('同步测试项目')), '刷新后数据仍在');
    /* 进入项目详情 + 甘特图 + 生产总览 */
    await c.evaluate(() => { const el = document.querySelector('.ck-pcard,[data-pid]'); el && el.click(); });
    await sleep(300);
    check(!(await c.$eval('#ck-detail', e => e.hidden)), '项目详情可打开');
    await c.click('#ck-tab-gantt'); await sleep(300);
    check((await c.$$('#ck-panel-gantt .gb')).length > 0, '甘特图有任务条');
    await c.evaluate(() => document.querySelector('#ck-nav button[data-page="production"]').click());
    await sleep(800);
    check(!(await c.$eval('#ck-production', e => e.hidden)), '生产总览可打开');
    if (SHOT) { fs.mkdirSync(SHOT, { recursive: true }); await c.screenshot({ path: path.join(SHOT, 'production.png') }); }
    check(c.errors.length === 0, '浏览各页面无 JS 错误 ' + c.errors.join(' | '));
    /* 各阶段的附加测试:test/ui.p<N>.js */
    for (const f of fs.readdirSync(__dirname).filter(x => /^ui\.p\d+\.js$/.test(x)).sort()) await require(path.join(__dirname, f))({ br, srv, open, sleep, check, SHOT });
  } catch (e) { console.error(e); check(false, '测试异常 ' + e.message); }
  finally { await br.close(); srv.stop(); }
  done();
})();
