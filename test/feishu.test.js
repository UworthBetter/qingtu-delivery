/* 飞书开放平台:规范化 / range 计算 / 分批写入 / 失败清理 / 协作者 / 多维表格(mock fetch,不真实调用飞书) */
'use strict';
const http = require('http');
const F = require('../lib/feishu.js');
const WIDE = require('./fixtures/wide.js');
const { startServer, api, check, done } = require('./helpers');

/* ---------- mock fetch:按「方法 路径」分发,记录全部调用 ---------- */
function mockFetch(handlers) {
  const calls = [];
  const fn = async (url, opt) => {
    const u = new URL(url), method = (opt && opt.method) || 'GET', body = opt && opt.body ? JSON.parse(opt.body) : null;
    const call = { method, path: u.pathname, query: u.searchParams, body };
    calls.push(call);
    if (u.pathname.endsWith('/tenant_access_token/internal')) return res({ code: 0, tenant_access_token: 't-1', expire: 7200 });
    for (const [k, h] of Object.entries(handlers)) {
      const [m, re] = k.split(' ');
      if (m === method && new RegExp('^' + re + '$').test(u.pathname)) return res(await h(call));
    }
    return res({ code: 99991, msg: 'no mock for ' + method + ' ' + u.pathname });
  };
  const res = j => ({ ok: true, status: 200, json: async () => j });
  return { fn, calls };
}
function client(env, handlers) {
  const m = mockFetch(handlers);
  global.fetch = m.fn;
  const ctx = { env: Object.assign({ FEISHU_APP_ID: 'cli', FEISHU_APP_SECRET: 's', FEISHU_DOMAIN: 'https://open.feishu.cn' }, env), store: { data: { outbox: [] }, save() {} }, broadcast() {} };
  return { fs: F(ctx), calls: m.calls };
}
const ok = data => ({ code: 0, data });
const quiet = fn => async (...a) => { const e = console.error; console.error = () => {}; try { return await fn(...a); } finally { console.error = e; } };

(async () => {
  const realFetch = global.fetch;
  try {
    console.log('飞书:规范化与 range');
    const sparse = [['标题'], [], []]; sparse[1][0] = '序号'; sparse[1][7] = '状态'; sparse[2][2] = undefined; sparse[5] = ['x', null, NaN, { v: 3 }];
    const n = F.normalizeValues(sparse);
    check(n.length === 6 && n.every(r => r.length === 8), '稀疏数组规范为 6×8 矩形');
    check(JSON.stringify(n).indexOf('null') < 0 && n[3].every(c => c === '') && n[1][3] === '' && n[5][3] === 3 && n[5][2] === '', '空洞 / undefined / null / NaN 均转为 "",{v} 取值');
    check(F.normalizeValues([['a', '', ''], ['', '', ''], []]).length === 1 && F.normalizeValues([['a', '', '']])[0].length === 1, '去掉尾部空行 / 空列');
    check(JSON.stringify(F.normalizeValues([])) === '[[""]]' && JSON.stringify(F.normalizeValues(null)) === '[[""]]', '空表规范为 1×1');
    check(F.colName(0) === 'A' && F.colName(25) === 'Z' && F.colName(26) === 'AA' && F.colName(701) === 'ZZ' && F.colName(702) === 'AAA', '列名换算 A / Z / AA / ZZ / AAA');
    check(F.rangeFor('s1', 0, 0, 17, 8) === 's1!A1:H17' && F.rangeFor('s1', 5000, 100, 3, 2) === 's1!CW5001:CX5003', 'range 计算');
    const big = F.normalizeValues(Array.from({ length: 12001 }, (_, i) => Array.from({ length: 130 }, (_, j) => i + ',' + j)));
    const parts = F.chunkValues('sh', big);
    const okParts = parts.every(p => { const m = p.range.match(/^sh!([A-Z]+)(\d+):([A-Z]+)(\d+)$/); const ci = s => [...s].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
      return m && p.values.length === +m[4] - +m[2] + 1 && p.values.every(r => r.length === ci(m[3]) - ci(m[1]) + 1) && p.values.length <= F.MAX_ROWS && p.values[0].length <= F.MAX_COLS
        && p.values[0][0] === (+m[2] - 1) + ',' + ci(m[1]); });
    check(parts.length === 6 && okParts, '12001×130 分 ' + parts.length + ' 批,每批 range 与 values 行列数严格一致');
    check(F.uniqueName('计划表', ['计划表', '计划表(2)'], 100) === '计划表(3)' && F.sheetName('a/b:c?') === 'a-b-c-', '重名 / 非法字符处理');

    console.log('飞书:导出到新建电子表格');
    let c = client({}, {
      'POST /open-apis/sheets/v3/spreadsheets': () => ok({ spreadsheet: { spreadsheet_token: 'shtNEW', url: 'https://x.feishu.cn/sheets/shtNEW' } }),
      'GET /open-apis/sheets/v3/spreadsheets/shtNEW/sheets/query': () => ok({ sheets: [{ sheet_id: 'b0', index: 1, grid_properties: { row_count: 200, column_count: 20 } }, { sheet_id: 'a9', index: 0, grid_properties: { row_count: 10, column_count: 20 } }] }),
      'POST /open-apis/sheets/v2/spreadsheets/shtNEW/dimension_range': () => ok({}),
      'PUT /open-apis/sheets/v2/spreadsheets/shtNEW/values': () => ok({})
    });
    let r = await c.fs.exportDoc({ title: 'T', rows: sparse.concat(Array.from({ length: 10 }, () => ['r'])) });
    const put = c.calls.filter(x => x.method === 'PUT');
    check(put.length === 1 && put[0].body.valueRange.range === 'a9!A1:H16' && put[0].body.valueRange.values.length === 16 && put[0].body.valueRange.values.every(x => x.length === 8), '写入真实首个工作表 a9,range A1:H16 与 16×8 值一致');
    const dim = c.calls.find(x => /dimension_range/.test(x.path));
    check(dim && dim.body.dimension.sheetId === 'a9' && dim.body.dimension.majorDimension === 'ROWS' && dim.body.dimension.length === 6, '工作表行数不足时先扩展 6 行');
    check(r.url === 'https://x.feishu.cn/sheets/shtNEW' && r.owner === 'app' && r.warning === F.OWNER_WARN, '未配置 FEISHU_OWNER_* 时返回链接并提示归属');

    console.log('飞书:写入失败时删除空表');
    c = client({}, {
      'POST /open-apis/sheets/v3/spreadsheets': () => ok({ spreadsheet: { spreadsheet_token: 'shtBAD', url: 'u' } }),
      'GET /open-apis/sheets/v3/spreadsheets/shtBAD/sheets/query': () => ok({ sheets: [{ sheet_id: 's1', index: 0 }] }),
      'PUT /open-apis/sheets/v2/spreadsheets/shtBAD/values': () => ({ code: 90202, msg: 'validate RangeVal fail' }),
      'DELETE /open-apis/drive/v1/files/shtBAD': () => ({ code: 1061004, msg: 'forbidden' })
    });
    let err = null; await quiet(async () => { try { await c.fs.exportDoc({ title: 'T', rows: [['a']] }); } catch (e) { err = e; } })();
    const del = c.calls.find(x => x.method === 'DELETE');
    check(err && /validate RangeVal fail/.test(err.message), '返回原始错误信息(删除失败不覆盖)');
    check(del && del.path === '/open-apis/drive/v1/files/shtBAD' && del.query.get('type') === 'sheet', '调用 drive 删除接口清理新建的表格');

    console.log('飞书:协作者与所有权');
    const shareMocks = extra => Object.assign({
      'POST /open-apis/sheets/v3/spreadsheets': () => ok({ spreadsheet: { spreadsheet_token: 'shtOK', url: 'https://x.feishu.cn/sheets/shtOK' } }),
      'GET /open-apis/sheets/v3/spreadsheets/shtOK/sheets/query': () => ok({ sheets: [{ sheet_id: 's1', index: 0 }] }),
      'PUT /open-apis/sheets/v2/spreadsheets/shtOK/values': () => ok({}),
      'POST /open-apis/drive/v1/permissions/shtOK/members': () => ok({ member: {} })
    }, extra);
    c = client({ FEISHU_OWNER_OPEN_ID: 'ou_abc' }, shareMocks({ 'POST /open-apis/drive/v1/permissions/shtOK/members/transfer_owner': () => ok({}) }));
    r = await c.fs.exportDoc({ title: 'T', rows: [['a']] });
    const mem = c.calls.find(x => /\/members$/.test(x.path)), tr = c.calls.find(x => /transfer_owner/.test(x.path));
    check(mem && mem.body.member_type === 'openid' && mem.body.member_id === 'ou_abc' && mem.body.perm === 'edit' && mem.query.get('type') === 'sheet', 'FEISHU_OWNER_OPEN_ID 加为可编辑协作者');
    check(tr && tr.body.member_type === 'openid' && r.owner === 'transferred' && !r.warning, '尝试转移所有权');
    c = client({ FEISHU_OWNER_EMAIL: 'boss@example.com' }, shareMocks({ 'POST /open-apis/drive/v1/permissions/shtOK/members/transfer_owner': () => ({ code: 1063002, msg: 'no permission' }) }));
    r = await quiet(() => c.fs.exportDoc({ title: 'T', rows: [['a']] }))();
    check(c.calls.find(x => /\/members$/.test(x.path)).body.member_type === 'email' && r.owner === 'collaborator' && r.url && !r.warning, 'FEISHU_OWNER_EMAIL;转移失败时保留协作者权限');

    console.log('飞书:写回已有电子表格');
    c = client({}, {
      'GET /open-apis/wiki/v2/spaces/get_node': () => ok({ node: { obj_type: 'sheet', obj_token: 'shtWIKI' } }),
      'GET /open-apis/sheets/v3/spreadsheets/shtWIKI/sheets/query': () => ok({ sheets: [{ sheet_id: 's0', title: 'HD-1 项目 2026-11-09', index: 0 }] }),
      'POST /open-apis/sheets/v2/spreadsheets/shtWIKI/sheets_batch_update': call => ok({ replies: [{ addSheet: { properties: { sheetId: 'nw1', title: call.body.requests[0].addSheet.properties.title } } }] }),
      'PUT /open-apis/sheets/v2/spreadsheets/shtWIKI/values': () => ok({})
    });
    r = await c.fs.exportDoc({ title: 'T', sheetTitle: 'HD-1 项目 2026-11-09', rows: [['a', 'b'], ['c']], url: 'https://x.feishu.cn/wiki/wikABC' });
    const add = c.calls.find(x => /sheets_batch_update/.test(x.path)), put2 = c.calls.find(x => x.method === 'PUT');
    check(add.body.requests[0].addSheet.properties.title === 'HD-1 项目 2026-11-09(2)' && put2.body.valueRange.range === 'nw1!A1:B2', '知识库链接 → 新建工作表(重名加序号)并写入');
    check(r.url === 'https://x.feishu.cn/wiki/wikABC?sheet=nw1' && r.owner === 'existing' && !c.calls.some(x => /permissions|v3\/spreadsheets$/.test(x.path)), '返回带 sheet 参数的链接,不新建表格、不改权限');

    console.log('飞书:多维表格导入');
    const tz = 'Asia/Shanghai', ms = F.dateMs('2026-11-04', tz);
    check(F.fmtDate(ms, tz) === '2026-11-04' && ms === Date.UTC(2026, 10, 3, 16), '日期毫秒时间戳按东八区换算');
    check(F.cellText([{ type: 'text', text: '机械' }, { type: 'text', text: '设计' }], 1) === '机械设计' && F.cellText(['A', 'B'], 4) === 'A、B' && F.cellText([{ id: 'ou', name: '张三' }, { name: '李四' }], 11) === '张三、李四'
      && F.cellText(12, 2) === '12' && F.cellText({ link: 'http://a', text: '链接' }, 15) === '链接' && F.cellText({ type: 1, value: [{ type: 'text', text: '公式' }] }, 20) === '公式' && F.cellText(true, 7) === '是', '文本 / 富文本 / 多选 / 人员 / 数字 / 链接 / 公式 / 复选框转纯文本');
    const fields = [{ field_name: '制作流程', type: 1 }, { field_name: '责任部门', type: 3 }, { field_name: '负责人', type: 11 }, { field_name: '开始时间', type: 5 }, { field_name: '结束时间', type: 5 }, { field_name: '流程周期', type: 2 }, { field_name: '状态', type: 1 }];
    const recs = [['立项', '项目部', '王经理', '2026-11-01', '2026-11-02', 2, '已完成'], ['机械设计', '技术部', '赵工', '2026-11-03', '2026-11-14', 12, '进行中 30%'], ['下料', '生产部', '', '2026-11-15', '2026-11-18', 4, '']]
      .map(a => ({ fields: { '制作流程': [{ type: 'text', text: a[0] }], '责任部门': a[1], '负责人': a[2] ? [{ name: a[2] }] : undefined, '开始时间': F.dateMs(a[3], tz), '结束时间': F.dateMs(a[4], tz), '流程周期': a[5], '状态': a[6] || undefined } }));
    c = client({}, {
      'GET /open-apis/bitable/v1/apps/bascnA/tables': () => ok({ items: [{ table_id: 'tblFIRST', name: '计划' }], has_more: false }),
      'GET /open-apis/bitable/v1/apps/bascnA/tables/tblFIRST/fields': () => ok({ items: fields, has_more: false }),
      'GET /open-apis/bitable/v1/apps/bascnA/tables/tblFIRST/records': call => call.query.get('page_token') ? ok({ items: recs.slice(2), has_more: false }) : ok({ items: recs.slice(0, 2), has_more: true, page_token: 'p2' })
    });
    const rows = await c.fs.readDoc('https://x.feishu.cn/base/bascnA');
    check(rows.length === 4 && rows[0][0] === '制作流程' && rows[2][0] === '机械设计' && rows[2][3] === '2026-11-03' && rows[2][2] === '赵工' && rows[3][6] === '', '无 table 参数取第一张数据表,分页读取全部 3 条记录');
    check(c.calls.filter(x => /records$/.test(x.path)).length === 2 && c.calls.find(x => /records$/.test(x.path)).query.get('page_size') === '500', '记录分页(page_token)');

    console.log('飞书:多维表格导出');
    const BT = [{ name: '制作流程', type: 1 }, { name: '开始时间', type: 5 }, { name: '流程周期', type: 2 }];
    const many = Array.from({ length: 1203 }, (_, i) => ({ '制作流程': '工序' + i, '开始时间': '2026-11-04', '流程周期': i % 5 ? 3 : '' }));
    c = client({ FEISHU_OWNER_EMAIL: 'boss@example.com' }, {
      'POST /open-apis/bitable/v1/apps': () => ok({ app: { app_token: 'bascNEW', url: 'https://x.feishu.cn/base/bascNEW' } }),
      'GET /open-apis/bitable/v1/apps/bascNEW/tables': () => ok({ items: [{ table_id: 'tblDEF', name: '数据表' }], has_more: false }),
      'POST /open-apis/bitable/v1/apps/bascNEW/tables': () => ok({ table_id: 'tblX' }),
      'POST /open-apis/bitable/v1/apps/bascNEW/tables/tblX/records/batch_create': () => ok({}),
      'DELETE /open-apis/bitable/v1/apps/bascNEW/tables/tblDEF': () => ok({}),
      'POST /open-apis/drive/v1/permissions/bascNEW/members': () => ok({}),
      'POST /open-apis/drive/v1/permissions/bascNEW/members/transfer_owner': () => ok({})
    });
    r = await c.fs.exportDoc({ target: 'bitable', title: 'T', sheetTitle: '项目 2026-11-09', bitable: { fields: BT, records: many } });
    const bc = c.calls.filter(x => /batch_create/.test(x.path)), tb = c.calls.find(x => x.method === 'POST' && /tables$/.test(x.path));
    check(tb.body.table.name === '项目 2026-11-09' && tb.body.table.fields.length === 3 && tb.body.table.fields[1].type === 5, '新建数据表并建好字段');
    check(bc.length === 3 && bc[0].body.records.length === 500 && bc[2].body.records.length === 203, 'batch_create 每批 500 条分 3 批');
    const f0 = bc[0].body.records[0].fields;
    check(f0['开始时间'] === F.dateMs('2026-11-04', tz) && !('流程周期' in f0) && bc[0].body.records[1].fields['流程周期'] === 3, '日期转毫秒、数字转数值、空值不写');
    check(c.calls.some(x => x.method === 'DELETE' && /tblDEF$/.test(x.path)) && c.calls.find(x => /bascNEW\/members$/.test(x.path)).query.get('type') === 'bitable', '删除默认空数据表;按 bitable 类型加协作者');
    check(r.kind === 'bitable' && r.url === 'https://x.feishu.cn/base/bascNEW?table=tblX' && r.owner === 'transferred', '返回多维表格链接');
    c = client({}, {
      'GET /open-apis/bitable/v1/apps/bascOLD/tables': () => ok({ items: [], has_more: false }),
      'POST /open-apis/bitable/v1/apps/bascOLD/tables': () => ok({ table_id: 'tblY' }),
      'POST /open-apis/bitable/v1/apps/bascOLD/tables/tblY/records/batch_create': () => ({ code: 1254045, msg: 'FieldNameNotFound' }),
      'DELETE /open-apis/bitable/v1/apps/bascOLD/tables/tblY': () => ok({})
    });
    err = null; try { await c.fs.exportDoc({ title: 'T', bitable: { fields: BT, records: many.slice(0, 2) }, url: 'https://x.feishu.cn/base/bascOLD?table=tblZ' }); } catch (e) { err = e; }
    check(err && /FieldNameNotFound/.test(err.message) && c.calls.some(x => x.method === 'DELETE' && /tblY$/.test(x.path)) && !c.calls.some(x => /drive\/v1\/files/.test(x.path)), '写入已有多维表格失败:只删除新建的数据表');
  } catch (e) { console.error(e); check(false, '测试异常 ' + e.message); }
  global.fetch = realFetch;

  /* ---------- 端到端:真实导出路由 → mock 飞书服务 ---------- */
  console.log('飞书:导出路由(mock 飞书服务)');
  const got = [], D = s => F.dateMs(s, 'Asia/Shanghai');
  const E2E_FIELDS = [{ field_name: '制作流程', type: 1 }, { field_name: '责任部门', type: 3 }, { field_name: '开始时间', type: 5 }, { field_name: '结束时间', type: 5 }, { field_name: '流程周期', type: 2 }];
  const E2E_RECS = [['立项', '项目部', '2026-11-01', '2026-11-02', 2], ['机械设计', '技术部', '2026-11-03', '2026-11-14', 12], ['下料', '生产部', '2026-11-15', '2026-11-18', 4], ['焊接', '生产部', '2026-11-19', '2026-11-28', 10]]
    .map(a => ({ fields: { '制作流程': [{ type: 'text', text: a[0] }], '责任部门': a[1], '开始时间': D(a[2]), '结束时间': D(a[3]), '流程周期': a[4] } }));
  const mock = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
      const u = new URL(req.url, 'http://x'), body = b ? JSON.parse(b) : null; got.push({ method: req.method, path: u.pathname, body });
      const out = j => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (/tenant_access_token/.test(u.pathname)) return out({ code: 0, tenant_access_token: 't', expire: 7200 });
      if (req.method === 'POST' && u.pathname === '/open-apis/sheets/v3/spreadsheets') return out(ok({ spreadsheet: { spreadsheet_token: 'shtE2E', url: 'https://x.feishu.cn/sheets/shtE2E' } }));
      if (/sheets\/query$/.test(u.pathname)) return out(ok({ sheets: [{ sheet_id: 'Q1w2', index: 0, grid_properties: { row_count: 200, column_count: 20 } }] }));
      if (req.method === 'PUT') {
        const vr = body.valueRange, m = vr.range.match(/^Q1w2!A1:([A-Z]+)(\d+)$/), cols = m ? m[1].charCodeAt(0) - 64 : -1;
        const valid = m && vr.values.length === +m[2] && vr.values.every(r => Array.isArray(r) && r.length === cols && r.every(c => c !== null));
        return out(valid ? ok({}) : { code: 90202, msg: 'validate RangeVal fail' });
      }
      if (u.pathname === '/open-apis/bitable/v1/apps/bascE2E/tables/tblP/fields') return out(ok({ items: E2E_FIELDS, has_more: false }));
      if (u.pathname === '/open-apis/bitable/v1/apps/bascE2E/tables/tblP/records') return out(ok({ items: E2E_RECS, has_more: false }));
      if (u.pathname === '/open-apis/bitable/v1/apps/DemoBaseToken0000000000000001/tables/tblDemo00000001/fields') return out(ok({ items: WIDE.fields, has_more: false }));
      if (u.pathname === '/open-apis/bitable/v1/apps/DemoBaseToken0000000000000001/tables/tblDemo00000001/records') {
        const pt = u.searchParams.get('page_token'), all = WIDE.records;
        return out(pt ? ok({ items: all.slice(10), has_more: false }) : ok({ items: all.slice(0, 10), has_more: true, page_token: 'pg2' }));
      }
      out({ code: 99991, msg: 'unexpected' });
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const srv = await startServer({ FEISHU_APP_ID: 'cli', FEISHU_APP_SECRET: 's', FEISHU_DOMAIN: 'http://127.0.0.1:' + mock.address().port, FEISHU_OWNER_OPEN_ID: '', FEISHU_OWNER_EMAIL: '' });
  try {
    const r = await api(srv.base, 'POST', '/api/export/hd-2585/feishu', {});
    const put = got.find(x => x.method === 'PUT');
    check(r.status === 200 && r.body.ok && r.body.url === 'https://x.feishu.cn/sheets/shtE2E', 'POST /api/export/hd-2585/feishu 成功 ' + JSON.stringify(r.body).slice(0, 120));
    check(put && put.body.valueRange.values[1][1] === '制作流程' && put.body.valueRange.values.every(x => x.length === 8), '写入值为严格矩形,表头正确');
    check(r.body.warning === F.OWNER_WARN, '返回中提示表格归应用所有');
    const im = await api(srv.base, 'POST', '/api/import/parse', { kind: 'feishu', url: 'https://x.feishu.cn/base/bascE2E?table=tblP&view=vewQ' });
    const md = im.body.tasks && im.body.tasks.find(t => t.name === '机械设计');
    check(im.status === 200 && im.body.tasks.length === 4 && md && md.start === '2026-11-03' && md.plan === 12 && md.dept === '技术部', '多维表格链接导入复用现有映射:4 道工序、日期 / 工期 / 部门识别');
    const wi = await api(srv.base, 'POST', '/api/import/parse', { kind: 'feishu', url: 'https://demo.feishu.cn/base/DemoBaseToken0000000000000001?table=tblDemo00000001&view=vewDemo0001' });
    const w1 = wi.body.projects && wi.body.projects.find(p => p.code === 'DEMO-119-PJ');
    check(wi.status === 200 && wi.body.wide && wi.body.projects.length === 22 && w1 && w1.tasks.find(t => t.name === '生产').owner === '郭子涵', '多维表格「项目执行表」(/base/ 链接,分页读取 22 条)→ 宽表识别 22 个项目');
    const bad = await api(srv.base, 'POST', '/api/export/hd-2585/feishu', { url: 'https://example.com/docx/abc' });
    check(bad.status === 400 && /无法识别/.test(bad.body.error), '无法识别的目标链接给出明确错误');
  } catch (e) { console.error(e); check(false, '测试异常 ' + e.message); }
  finally { srv.stop(); mock.close(); }
  done();
})();
