/* 服务端 API 快速测试 */
'use strict';
const fs = require('fs');
const path = require('path');
const { startServer, api, check, done } = require('./helpers');
(async () => {
  const srv = await startServer();
  try {
    console.log('基础 API');
    const info = await api(srv.base, 'GET', '/api/info');
    check(info.body.ok && info.body.today === '2026-11-09', '/api/info 返回日期');
    const d = await api(srv.base, 'GET', '/api/data');
    check(d.body.defs.length >= 10, '种子数据 ' + d.body.defs.length + ' 个项目');
    const P = d.body.defs[0], rev = d.body.rev[P.id];
    const put = await api(srv.base, 'PUT', '/api/projects', { upsert: { [P.id]: { def: Object.assign({}, P, { name: 'X' }), state: d.body.projects[P.id] } }, revs: { [P.id]: rev } });
    check(put.status === 200 && put.body.ok, 'PUT 修改项目');
    const stale = await api(srv.base, 'PUT', '/api/projects', { upsert: { [P.id]: { def: P, state: d.body.projects[P.id] } }, revs: { [P.id]: rev } });
    check(stale.status === 409, '旧版本号修改返回 409 冲突');
    await new Promise(r => setTimeout(r, 400));
    const stored = JSON.parse(fs.readFileSync(path.join(srv.dir, 'store.json'), 'utf8'));
    check(stored.defs.find(x => x.id === P.id).name === 'X', '已写入 data/store.json');
    const rs = await api(srv.base, 'POST', '/api/reset');
    check(rs.body.ok, '重置演示数据');
    const s404 = await api(srv.base, 'GET', '/server.js');
    check(s404.status === 404, '不暴露服务端源码');
    /* 各阶段的附加测试:test/api.p<N>.js */
    for (const f of fs.readdirSync(__dirname).filter(x => /^api\.p\d+\.js$/.test(x)).sort()) await require(path.join(__dirname, f))({ srv, api, check });
  } catch (e) { console.error(e); check(false, '测试异常 ' + e.message); }
  finally { srv.stop(); }
  done();
})();
